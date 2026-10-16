# Moneybird

A Swell app that books paid orders in [Moneybird](https://www.moneybird.com) as sales invoices or external sales
invoices, registers their payments, books refunds as credit invoices, and keeps the customer's Moneybird contact up to
date. It uses the [Moneybird API v2](https://developer.moneybird.com) with a personal API token.

## Features

All calls go to `https://moneybird.com/api/v2/<administration id>/….json` (the list of administrations to
`/api/v2/administrations.json`) with `Authorization: Bearer <API token>`. Moneybird IDs are 18-digit numbers and are
kept as strings.

| Swell event                | What happens in Moneybird                                     | Function                     |
| -------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `order.paid`               | Contact found or created, invoice created, numbered and paid  | `functions/order-events.ts`  |
| `payment.refund.succeeded` | Credit invoice (or negative external invoice) for the refund  | `functions/refund-events.ts` |
| `account.updated`          | The customer's existing contact is updated                    | `functions/account-events.ts`|

### Orders

When an order is paid (`order.paid`), and it isn't a draft and its total is above 0:

1. **Contact** – the contact whose `customer_id` is the Swell customer ID
   (`GET /contacts/customer_id/<id>`), else a new contact (`POST /contacts`) with the customer's name, the billing
   address (the order's, else the customer's saved one; the shipping address when neither has a street or city),
   phone, email (`send_invoices_to_email`, delivery by email), VAT number (`tax_number`) and the address's company as
   `company_name`. Without a name or company, the customer's full name field or email becomes `company_name`. Moneybird
   checks that the email's domain can receive mail; when it refuses the email, the contact is created without it
   (delivery `Manual`) and the order's note says so. The contact's ID and link are saved on the customer.
2. **Invoice** – with **Book orders as**:
   - *Sales invoices* (default): `POST /sales_invoices` with reference `Order <number>`, the order date, currency,
     the optional workflow and document style. Before creating, the app looks for an invoice with that reference
     (`find_by_reference`), so an invoice created by a run whose result wasn't saved is reused.
   - *External sales invoices*: `POST /external_sales_invoices` with the order number as reference, source `Swell`
     and a link back to the order (`source_url`, when Swell gives the admin URL).
3. **Number** – a new sales invoice is a draft without a number. With **New sales invoices** set to *Mark as sent*
   (default) the app sends it with `delivery_method: Manual` (no email); with *Email to the customer* Moneybird
   emails it; with *Leave as draft* it stays a draft and the payment isn't registered.
4. **Payment** – with **Register payments** on, `POST /…/<id>/payments` for the invoice's unpaid total, with the same
   amount in the administration's currency (`price_base`, from `total_unpaid_base`; Moneybird requires it for
   invoices in another currency), dated when
   `order.paid` fired (the order date for orders sent later), with `transaction_identifier: Swell order <number>`, the
   optional **Financial account ID**, and `manual_payment_action: payment_without_proof` when **Payments without proof**
   is on.

Each step is saved on the order (`moneybird_invoice_id`, `moneybird_state`, `moneybird_paid_at`), so a retry or a
later **Send to Moneybird** continues where the last run stopped. An invoice keeps the type it was created as when
**Book orders as** changes later.

**Lines.** One line per item (`<product> – <variant>`, unit price after item discounts, quantity) and one for shipping
(`Shipping – <service>`, after the shipping discount). `prices_are_incl_tax` follows the store's
`item_tax_included`; shipping priced on the other basis is converted with its tax. Each line gets the Moneybird sales
tax rate (`tax_rate_type: sales_invoice`, active) with the percentage Swell charged on it, preferring a rate for the
billing country (the shipping country without one), then one without a country; when none matches, the **Default tax
rate ID**, else Moneybird's default.
**Revenue ledger account ID** is set on every line when given. Gift cards and account credit are payments in Swell and
aren't invoice lines.

The order's **Note** shows tax percentages without a matching rate and a Moneybird total that differs from Swell's
grand total.

### Refunds

With **Send refunds** on, each successful Swell refund of an order that is in Moneybird becomes:

- a credit sales invoice (reference `Refund <refund number> of order <number>`, dated on the refund) for sales
  invoices; **New sales invoices** applies to it like to invoices, and with **Register payments** on it gets a negative
  payment; or
- a negative external sales invoice (reference `<order number>-R<refund number>`) for external invoices, with a
  negative payment when **Register payments** is on.

The type is the one the order's invoice was created as. Its lines are the refunded share of the order, one per tax
percentage (`Refund of order <number>`, with `(21% tax)` added when the order has several percentages), so the tax is
reversed in proportion. A refund is never more than the part of the order not refunded in Moneybird yet.

Each refund is sent once. The credit invoice's ID is saved as soon as it's created (`moneybird_refunds`, by Swell
refund ID), and the refund counts as done when it's numbered and paid (`moneybird_refunds_done`). If a later step fails
temporarily, Swell runs the refund event again and the app finishes that credit invoice instead of creating another; a
payment an earlier run registered isn't registered twice. Refunds of payments without an order aren't sent.

### Contacts

With **Update contacts** on, a change to a customer's name, email, phone, billing or shipping address or VAT number
(`account.updated` with these fields in `$event.data`) updates their Moneybird contact (`PATCH /contacts/<id>`), when
they have one; an email Moneybird refuses is left out and the rest is updated. The Swell values replace the ones in
Moneybird, including the delivery method (email when the customer has an email). Contacts are created only with the
customer's first order sent to Moneybird.

### Dashboard

- **Moneybird tab** on orders: invoice number (the reference for external invoices), state, link to Moneybird, when
  the payment was registered, refunded total, credit invoices, note and the last error. The order list has a
  **Moneybird** column with the invoice number.
- **Moneybird tab** on customers with a link to the contact.
- **Send to Moneybird** in an order's Actions menu and as a bulk action on up to 10 selected orders: sends paid
  orders that aren't in Moneybird yet and finishes the ones that stopped halfway. Selecting more shows "Select up to
  10 orders." and sends nothing.

  **Why 10:** the action runs while the admin waits for its answer, in a single function call with a time limit, and
  Moneybird allows 150 requests per 5 minutes. Each order takes up to 8 requests, so 10 orders (about 80 requests)
  finish in one call and leave room for the event functions sending new orders at the same time. More orders would
  risk hitting Moneybird's limit or the time limit halfway. For more orders, use **Send existing orders**: it runs in
  the background and waits and retries when Moneybird's limit is reached.
- **Send existing orders** in the app's Actions menu: a background workflow that sends paid orders placed in the last
  7, 30 or 90 days, 10 per page, one order at a time. Refunds made before aren't sent.
- **Test connection** (below).

Every problem in **Send to Moneybird** and **Test connection** is a red error popup (a `SwellError` with status
400); results are a regular message, and one that lists failed orders next to sent ones stays regular. **Send existing
orders** reports problems by failing its run.

### Errors and retries

| Moneybird response               | Handling                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| 401                              | "Moneybird rejected the API token …"                                                     |
| 403                              | "The API token isn't allowed to do this …" (needs sales invoices and settings)          |
| 402                              | "Your Moneybird plan doesn't allow this …" (e.g. the free plan's invoice limit)         |
| 422                              | "Moneybird refused it: …" with Moneybird's field errors                                  |
| 429, 5xx, network errors         | Temporary: "… try again later"; the event function throws so Swell runs it again         |
| Anything else (e.g. 404)         | "Moneybird request failed: …" with the refused call                                       |

A failure is saved on the order as `moneybird_error` ("Couldn't create the invoice: …", "Couldn't register the
payment: …") and cleared by the next successful step. Event functions rethrow temporary errors only when running again
can't create a second document: an external invoice or credit invoice whose creation failed with a 5xx or network error
isn't retried, because Moneybird can't look it up. Check Moneybird, then use **Send to Moneybird** for an order; a
refund in that state has to be booked by hand. The customer-contact update is retried on temporary errors too. Saving a
result on the order is only logged when it fails.

Moneybird allows 150 requests per 5 minutes. Sending an order takes 5–9 requests (fewer in the actions, which load
the tax rates once), so the import goes one order at a time and retries a page that hits the limit (6 times, from 1
minute, doubling).

## Settings

**Apps → Moneybird → Settings** (`settings/moneybird.json`). Credentials are never stored in code.

| Setting                 | Type   | Default         | Description                                                                                   |
| ----------------------- | ------ | --------------- | --------------------------------------------------------------------------------------------- |
| `api_token`             | secret |                 | Required. Personal API token with access to sales invoices and settings.                     |
| `administration_id`     | text   |                 | Needed to send. Empty: **Test connection** finds it.                                          |
| `enabled`               | toggle | on              | Turns off everything the app sends.                                                           |
| `invoice_type`          | select | `sales_invoice` | `sales_invoice` or `external_sales_invoice`.                                                  |
| `finalize`              | select | `manual`        | Sales and credit invoices: `manual` (mark as sent), `email`, `draft`.                         |
| `workflow_id`           | text   |                 | Sales invoices: Moneybird workflow; empty uses the default.                                  |
| `document_style_id`     | text   |                 | Sales invoices: document style; empty uses the default.                                      |
| `default_tax_rate_id`   | text   |                 | Tax rate for lines whose percentage has no Moneybird rate.                                   |
| `ledger_account_id`     | text   |                 | Revenue ledger account for every line.                                                        |
| `register_payments`     | toggle | on              | Register the payment on the invoice.                                                          |
| `financial_account_id`  | text   |                 | Financial account the payment is booked on.                                                   |
| `payment_without_proof` | toggle | off             | Register payments as payment without proof (turn it on in Moneybird first).                  |
| `send_refunds`          | toggle | on              | Book refunds as credit invoices.                                                              |
| `sync_contacts`         | toggle | on              | Update contacts when customers change.                                                        |

## Test connection

**Apps → Moneybird → Actions → Test connection** (`functions/test-connection.ts`) only reads from Moneybird and works
while the app is off:

- without an **Administration ID**: lists the administrations the token can use (`GET /administrations`) with their
  IDs, to copy into the settings;
- with one: checks the token can use it, and lists the active sales tax rates and the financial accounts with their IDs;
- with **Enabled** off it adds "The app is turned off, so nothing is sent until you turn it on."
- a missing token, an administration the token can't use, and Moneybird's refusals show as red errors.

## Turning the app off

With **Enabled** off:

- the event functions return before loading any record or calling Moneybird;
- **Send to Moneybird** refuses with "The Moneybird app is turned off in its settings.", and one that is running
  sends no more orders ("Stopped before 2 more: the app was turned off in its settings.");
- **Send existing orders** doesn't start ("Import not started: the Moneybird app is turned off in its settings."),
  and a running import checks the settings before each order and stops, failing with the totals so far;
- **Test connection** still works and says the app is off.

Nothing is sent either while the API token or Administration ID is missing: the event functions log an error, and
the actions ask for the missing setting ("Add the Administration ID in Apps → Moneybird first.", "Import not started:
add the …").

## Setup

1. In Moneybird open **Settings → External applications and AI connections → New API token**, give it access to
   sales invoices and settings, and copy it.
2. Install the app, open **Apps → Moneybird → Settings**, paste the token, save, and run **Test connection**.
3. Copy your administration's ID into **Administration ID**, save, and run **Test connection** again. It lists your
   sales tax rates and financial accounts.
4. Choose **Book orders as** and, for sales invoices, what happens to new invoices. Optionally set the workflow,
   document style, default tax rate, revenue ledger account and financial account.
5. Place and pay a test order, and open its **Moneybird** tab.
6. To send earlier orders, run **Actions → Send existing orders**.

## Limits and known behavior

- **Only paid orders** – orders are sent when they're paid; unpaid, draft and free orders aren't.
- **Canceled orders** – canceling an order doesn't change its invoice. Refund it in Swell to book a credit invoice.
- **Tax rates** – a line's rate is matched by percentage. Create the missing rates in Moneybird, or set a default
  tax rate; the order's note lists the percentages without a match.
- **Totals** – Moneybird calculates tax per line, so with prices that exclude tax its total can differ from Swell's by
  a cent; the order's note says so, and the payment registered is Moneybird's unpaid total.
- **Contacts** are matched by Swell customer ID. A contact created in Moneybird by hand isn't linked unless its
  customer ID is the Swell customer ID. With **Update contacts** on, changes made to a linked contact in Moneybird are
  overwritten the next time the customer changes in Swell.
- **Edits after sending** – changing an order in Swell after it was sent doesn't change the invoice.
- **Rate limit** – Moneybird allows 150 requests per 5 minutes; large imports take a while.

## Development

```
functions/
  order-events.ts      # order.paid → contact, invoice, number, payment
  refund-events.ts     # payment.refund.succeeded → credit invoice
  account-events.ts    # account.updated → contact update
  send-to-moneybird.ts # order and bulk action
  import-orders.ts     # workflow: paid orders of the last 7/30/90 days
  test-connection.ts   # settings action
  lib/
    moneybird.ts       # settings, API client, errors, tax rates
    invoices.ts        # contacts, lines, invoices, payments, refunds
models/                # Moneybird fields on orders and accounts
content/               # Moneybird tabs, order list column and actions
settings/moneybird.json
test/unit/             # vitest unit tests (Moneybird API mocked with fetch)
```

```bash
npm install
npm run typecheck
npm test
swell app push                    # use --force after changing only functions/lib/*
swell inspect functions --app=.
swell logs --type function -s Moneybird
```

## License

MIT – see [LICENSE](LICENSE).
