import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  contactFields,
  detailsAttributes,
  externalReference,
  forInvoice,
  orderLines,
  orderReference,
  orderSkipReason,
  recordPath,
  refundLines,
  retryIfTemporary,
  syncOrder,
  syncRefund,
  transactionIdentifier,
} from "../../functions/lib/invoices";
import { MoneybirdError } from "../../functions/lib/moneybird";
import {
  ACCOUNT_ID,
  ADMIN,
  CONTACT_ID,
  CREDIT_ID,
  INVOICE_ID,
  ORDER_ID,
  REFUND_ID,
  SWELL_INVOICE_ID,
  bodyOf,
  callKeys,
  calls,
  fail,
  makeInvoice,
  makeOrder,
  makeSettings,
  makeSubscriptionInvoice,
  makeSwell,
  mockMoneybird,
  ok,
  savedOn,
} from "../helpers/moneybird-fixtures";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T09:00:00.000Z"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const orderPath = `/orders/${ORDER_ID}`;
const withApp = (values: Record<string, any>, overrides: Record<string, any> = {}) => makeOrder({ $app: { moneybird: values }, ...overrides });

describe("lines", () => {
  it("lists items and shipping in the order's price basis with Swell's tax percentage", () => {
    expect(orderLines(makeOrder())).toEqual([
      { description: "Tee – M", price: 24.2, amount: 2, percentage: 21 },
      { description: "Shipping – PostNL", price: 6.05, amount: 1, percentage: 21 },
    ]);
  });

  it("keeps prices without tax for stores that add tax on top", () => {
    const order = makeOrder({
      item_tax_included: false,
      items: [{ product_name: "Mug", price: 10, tax_each: 0.9, quantity: 1 }],
      shipment_price: 6.05,
      shipment_tax: 1.05,
      shipment_tax_included: true,
    });
    expect(orderLines(order)).toEqual([
      { description: "Mug", price: 10, amount: 1, percentage: 9 },
      { description: "Shipping – PostNL", price: 5, amount: 1, percentage: 21 },
    ]);
  });

  it("splits a refund by tax percentage, adding up to the refund", () => {
    const order = makeOrder({
      items: [
        { product_name: "Tee", price: 12.1, tax_each: 2.1, quantity: 1 },
        { product_name: "Book", price: 10.9, tax_each: 0.9, quantity: 1 },
      ],
      shipment_price: 0,
      grand_total: 23,
    });
    const lines = refundLines(order, 10);
    expect(lines.map((l) => l.percentage)).toEqual([21, 9]);
    expect(lines.reduce((s, l) => s + l.price, 0)).toBeCloseTo(-10, 2);
    expect(lines[0].description).toBe("Refund of order 100546 (21% tax)");
    expect(refundLines(makeOrder(), 100)).toEqual([{ description: "Refund of order 100546", price: -54.45, amount: 1, percentage: 21 }]);
  });

  it("gives each line its tax rate, ledger account, and the default rate when none matches", () => {
    const rates = [{ id: "tr_21", name: "21%", percentage: 21, country: null }];
    const settings = makeSettings({ default_tax_rate_id: "tr_def", ledger_account_id: "la_1" });
    const { details, unmatched } = detailsAttributes(
      [
        { description: "A", price: 10, amount: 2, percentage: 21 },
        { description: "B", price: 5.5, amount: 1, percentage: 7 },
      ],
      rates,
      settings,
    );
    expect(details).toEqual([
      { description: "A", price: "10.00", amount: "2", tax_rate_id: "tr_21", ledger_account_id: "la_1" },
      { description: "B", price: "5.50", amount: "1", tax_rate_id: "tr_def", ledger_account_id: "la_1" },
    ]);
    expect(unmatched).toEqual([7]);
  });
});

describe("contacts", () => {
  it("maps the customer and the order's billing address", () => {
    expect(contactFields(makeOrder().account, makeOrder())).toEqual({
      customer_id: ACCOUNT_ID,
      firstname: "Jane",
      lastname: "Doe",
      address1: "Hoofdstraat 1",
      zipcode: "1234AB",
      city: "Amsterdam",
      country: "NL",
      send_invoices_to_email: "jane@example.com",
      delivery_method: "Email",
    });
  });

  it("keeps the customer's billing address when the order's billing fields are empty", () => {
    const account = { id: "a", email: "x@y.z", first_name: "Jo", billing: { address1: "Dam 1", city: "Amsterdam", country: "NL" } };
    const order = { billing: { method: "account", address1: null, city: null, country: null } };
    expect(contactFields(account, order)).toMatchObject({ address1: "Dam 1", city: "Amsterdam", country: "NL" });
  });

  it("uses the company, and the email when there's no name", () => {
    expect(contactFields({ id: "a", email: "x@y.z" }, { billing: { company: "Acme BV" } })).toMatchObject({ company_name: "Acme BV" });
    expect(contactFields({ id: "a", email: "x@y.z" })).toMatchObject({ company_name: "x@y.z" });
    expect(contactFields({ id: "a", email: "x@y.z", vat_number: "NL1B01" }).tax_number).toBe("NL1B01");
  });
});

describe("syncOrder", () => {
  it("creates, numbers and pays a sales invoice, and saves each step", async () => {
    const fetchMock = mockMoneybird();
    const swell = makeSwell();
    const result = await syncOrder(swell as any, makeSettings(), makeOrder(), { adminUrl: "https://a" });

    expect(result).toEqual({ status: "sent", invoice_id: INVOICE_ID, done: ["created", "marked as sent", "payment registered"] });
    expect(callKeys(fetchMock)).toEqual([
      "GET /sales_invoices/find_by_reference/Order%20100546",
      `GET /contacts/customer_id/${ACCOUNT_ID}`,
      "GET /tax_rates",
      "POST /sales_invoices",
      `PATCH /sales_invoices/${INVOICE_ID}/send_invoice`,
      `GET /sales_invoices/${INVOICE_ID}`,
      `POST /sales_invoices/${INVOICE_ID}/payments`,
    ]);
    expect(bodyOf(fetchMock, "POST /sales_invoices")).toEqual({
      sales_invoice: {
        contact_id: CONTACT_ID,
        reference: "Order 100546",
        invoice_date: "2026-10-15",
        currency: "EUR",
        prices_are_incl_tax: true,
        details_attributes: [
          { description: "Tee – M", price: "24.20", amount: "2", tax_rate_id: "tr_21" },
          { description: "Shipping – PostNL", price: "6.05", amount: "1", tax_rate_id: "tr_21" },
        ],
      },
    });
    expect(bodyOf(fetchMock, `PATCH /sales_invoices/${INVOICE_ID}/send_invoice`)).toEqual({ sales_invoice_sending: { delivery_method: "Manual" } });
    expect(bodyOf(fetchMock, `POST /sales_invoices/${INVOICE_ID}/payments`)).toEqual({
      payment: { payment_date: "2026-10-15", price: "54.45", transaction_identifier: "Swell order 100546" },
    });
    expect(savedOn(swell, orderPath)).toMatchObject({
      moneybird_invoice_id: INVOICE_ID,
      moneybird_invoice_type: "sales_invoice",
      moneybird_invoice_number: "2026-0042",
      moneybird_invoice_url: `https://moneybird.com/${ADMIN}/sales_invoices/${INVOICE_ID}`,
      moneybird_state: "paid",
      moneybird_status: "Paid",
      moneybird_paid_at: "2026-10-16T09:00:00.000Z",
      moneybird_note: null,
      moneybird_error: null,
    });
    expect(savedOn(swell, `/accounts/${ACCOUNT_ID}`)).toEqual({
      moneybird_contact_id: CONTACT_ID,
      moneybird_contact_url: `https://moneybird.com/${ADMIN}/contacts/${CONTACT_ID}`,
    });
  });

  it("creates the contact when the customer has none", async () => {
    const fetchMock = mockMoneybird({ [`GET /contacts/customer_id/${ACCOUNT_ID}`]: fail(404, "record not found") });
    await syncOrder(makeSwell() as any, makeSettings(), makeOrder());
    expect(bodyOf(fetchMock, "POST /contacts").contact).toMatchObject({ customer_id: ACCOUNT_ID, firstname: "Jane", country: "NL" });
  });

  it("creates the contact without an email Moneybird refuses, and notes it", async () => {
    const refused = fail(422, { send_invoices_to_email: ["includes a domain which cannot receive emails"] });
    const fetchMock = mockMoneybird({
      [`GET /contacts/customer_id/${ACCOUNT_ID}`]: fail(404, "record not found"),
      "POST /contacts": [refused, ok({ id: CONTACT_ID }, 201)],
    });
    const swell = makeSwell();
    expect((await syncOrder(swell as any, makeSettings(), makeOrder())).status).toBe("sent");
    const posts = calls(fetchMock).filter((c) => c.key === "POST /contacts");
    expect(posts[0].body.contact).toMatchObject({ send_invoices_to_email: "jane@example.com", delivery_method: "Email" });
    expect(posts[1].body.contact).not.toHaveProperty("send_invoices_to_email");
    expect(posts[1].body.contact.delivery_method).toBe("Manual");
    expect(savedOn(swell, orderPath).moneybird_note).toBe(
      "Moneybird refused the customer's email (its domain can't receive mail), so the contact has no invoice email.",
    );
  });

  it("emails the invoice, uses the workflow, style, financial account and payments without proof", async () => {
    const fetchMock = mockMoneybird();
    const settings = makeSettings({ finalize: "email", workflow_id: "wf", document_style_id: "ds", financial_account_id: "fa_1", payment_without_proof: true });
    await syncOrder(makeSwell() as any, settings, makeOrder());
    expect(bodyOf(fetchMock, "POST /sales_invoices").sales_invoice).toMatchObject({ workflow_id: "wf", document_style_id: "ds" });
    expect(bodyOf(fetchMock, `PATCH /sales_invoices/${INVOICE_ID}/send_invoice`)).toEqual({ sales_invoice_sending: { delivery_method: "Email" } });
    expect(bodyOf(fetchMock, `POST /sales_invoices/${INVOICE_ID}/payments`).payment).toMatchObject({
      financial_account_id: "fa_1",
      manual_payment_action: "payment_without_proof",
    });
  });

  it("adds the amount in the administration's currency for an invoice in another currency", async () => {
    const fetchMock = mockMoneybird({
      [`GET /sales_invoices/${INVOICE_ID}`]: ok(makeInvoice({ state: "open", currency: "USD", total_unpaid: "54.45", total_unpaid_base: "50.12" })),
    });
    await syncOrder(makeSwell() as any, makeSettings(), makeOrder({ currency: "USD" }));
    expect(bodyOf(fetchMock, `POST /sales_invoices/${INVOICE_ID}/payments`).payment).toMatchObject({ price: "54.45", price_base: "50.12" });
  });

  it("leaves a draft without registering the payment", async () => {
    const fetchMock = mockMoneybird();
    const swell = makeSwell();
    expect(await syncOrder(swell as any, makeSettings({ finalize: "draft" }), makeOrder())).toMatchObject({ status: "sent", done: ["created"] });
    expect(callKeys(fetchMock)).not.toContain(`PATCH /sales_invoices/${INVOICE_ID}/send_invoice`);
    expect(savedOn(swell, orderPath)).toMatchObject({ moneybird_state: "draft", moneybird_status: "Draft" });
  });

  it("books an external sales invoice with the order number and a link back", async () => {
    const fetchMock = mockMoneybird();
    const swell = makeSwell();
    const result = await syncOrder(swell as any, makeSettings({ invoice_type: "external_sales_invoice" }), makeOrder(), { adminUrl: "https://a/admin" });
    expect(result).toMatchObject({ status: "sent", done: ["created", "payment registered"] });
    expect(callKeys(fetchMock)).not.toContain("GET /sales_invoices/find_by_reference/Order%20100546");
    expect(bodyOf(fetchMock, "POST /external_sales_invoices").external_sales_invoice).toMatchObject({
      reference: "100546",
      date: "2026-10-15",
      source: "Swell",
      source_url: `https://a/admin/orders/${ORDER_ID}`,
    });
    expect(savedOn(swell, orderPath)).toMatchObject({
      moneybird_invoice_number: "100546",
      moneybird_invoice_url: `https://moneybird.com/${ADMIN}/external_sales_invoices/${INVOICE_ID}`,
    });
  });

  it("finishes an invoice an earlier run left halfway, with the type it was created as", async () => {
    const fetchMock = mockMoneybird();
    const order = withApp({ moneybird_invoice_id: INVOICE_ID, moneybird_invoice_type: "sales_invoice", moneybird_state: "draft" });
    const result = await syncOrder(makeSwell() as any, makeSettings({ invoice_type: "external_sales_invoice" }), order);
    expect(result).toMatchObject({ status: "updated", done: ["marked as sent", "payment registered"] });
    expect(callKeys(fetchMock)).not.toContain("POST /sales_invoices");
  });

  it("links an invoice an earlier run created but didn't save", async () => {
    const fetchMock = mockMoneybird({ "GET /sales_invoices/find_by_reference/Order%20100546": ok(makeInvoice({ state: "open", invoice_id: "2026-0042" })) });
    const result = await syncOrder(makeSwell() as any, makeSettings(), makeOrder());
    expect(result).toMatchObject({ status: "updated", done: ["payment registered"] });
    expect(callKeys(fetchMock)).not.toContain("POST /sales_invoices");
  });

  it("does nothing for a finished order", async () => {
    const fetchMock = mockMoneybird();
    const order = withApp({ moneybird_invoice_id: INVOICE_ID, moneybird_state: "paid", moneybird_paid_at: "x" });
    expect(await syncOrder(makeSwell() as any, makeSettings(), order)).toEqual({ status: "unchanged", reason: "already in Moneybird" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips orders that aren't paid, drafts and free orders", async () => {
    const fetchMock = mockMoneybird();
    for (const [order, reason] of [
      [makeOrder({ paid: false }), "order is not paid"],
      [makeOrder({ draft: true }), "order is a draft"],
      [makeOrder({ grand_total: 0 }), "order total is 0"],
      [null, "order not found"],
    ] as const) {
      expect(await syncOrder(makeSwell() as any, makeSettings(), order)).toEqual({ status: "skipped", reason });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("notes tax rates without a match and a different total", async () => {
    mockMoneybird({ "POST /sales_invoices": ok(makeInvoice({ total_price_incl_tax: "54.46" }), 201) });
    const swell = makeSwell();
    const order = makeOrder({ items: [{ product_name: "Book", price: 10.7, tax_each: 0.7, quantity: 1 }], shipment_price: 0, grand_total: 10.7 });
    await syncOrder(swell as any, makeSettings(), order);
    expect(savedOn(swell, orderPath).moneybird_note).toBe(
      "No Moneybird sales tax rate of 7%: used the administration's default tax rate. The Moneybird total 54.46 differs from the Swell total 10.70.",
    );
  });

  it("saves the failing step's error; retries only what can't duplicate", async () => {
    mockMoneybird({ [`PATCH /sales_invoices/${INVOICE_ID}/send_invoice`]: fail(422, "contact has no email") });
    const swell = makeSwell();
    const result = await syncOrder(swell as any, makeSettings(), makeOrder());
    expect(result).toMatchObject({ status: "failed", reason: "Couldn't mark the invoice as sent: Moneybird refused it: contact has no email", retry: true });
    expect(savedOn(swell, orderPath)).toMatchObject({ moneybird_invoice_id: INVOICE_ID, moneybird_error: result.status === "failed" ? result.reason : "" });

    vi.restoreAllMocks();
    mockMoneybird({ "POST /external_sales_invoices": fail(502, "bad gateway") });
    const external = await syncOrder(makeSwell() as any, makeSettings({ invoice_type: "external_sales_invoice" }), makeOrder());
    expect(external).toMatchObject({ status: "failed", retry: false });
    expect(() => retryIfTemporary(external)).not.toThrow();

    vi.restoreAllMocks();
    mockMoneybird({ "POST /sales_invoices": fail(502, "bad gateway") });
    const sales = await syncOrder(makeSwell() as any, makeSettings(), makeOrder());
    expect(() => retryIfTemporary(sales)).toThrow(MoneybirdError);
  });
});

describe("syncRefund", () => {
  const refund = { id: REFUND_ID, amount: 10, number: "100015", date_created: "2026-10-16T08:00:00.000Z" };
  const sent = (values: Record<string, any> = {}) => withApp({ moneybird_invoice_id: INVOICE_ID, moneybird_invoice_type: "sales_invoice", ...values });
  const credit = (overrides: Record<string, any> = {}) => makeInvoice({ id: CREDIT_ID, total_price_incl_tax: "-10.0", ...overrides });

  it("creates, numbers and pays a credit invoice for the refund", async () => {
    const fetchMock = mockMoneybird({
      "POST /sales_invoices": ok(credit(), 201),
      [`PATCH /sales_invoices/${CREDIT_ID}/send_invoice`]: ok(credit({ state: "open", invoice_id: "2026-0043", total_unpaid: "-10.0", total_unpaid_base: "-9.2" })),
      [`POST /sales_invoices/${CREDIT_ID}/payments`]: ok({ id: "pay_2" }, 201),
    });
    const swell = makeSwell();
    const result = await syncRefund(swell as any, makeSettings(), sent({ moneybird_credit_invoices: "earlier" }), refund);

    expect(result).toEqual({ status: "sent", invoice_id: CREDIT_ID, done: ["refund"] });
    expect(bodyOf(fetchMock, "POST /sales_invoices").sales_invoice).toMatchObject({
      reference: "Refund 100015 of order 100546",
      invoice_date: "2026-10-16",
      details_attributes: [{ description: "Refund of order 100546", price: "-10.00", amount: "1", tax_rate_id: "tr_21" }],
    });
    expect(bodyOf(fetchMock, `POST /sales_invoices/${CREDIT_ID}/payments`).payment).toMatchObject({ price: "-10.00", price_base: "-9.20", payment_date: "2026-10-16" });
    expect(savedOn(swell, orderPath)).toEqual({
      moneybird_refunds: { [REFUND_ID]: CREDIT_ID },
      moneybird_refunds_done: { [REFUND_ID]: true },
      moneybird_refund_total: 10,
      moneybird_credit_invoices: "earlier\nRefund 100015: credit invoice 2026-0043 (−10.00 EUR)",
      moneybird_error: null,
    });
  });

  it("caps the refund at the part of the order not refunded yet", async () => {
    const fetchMock = mockMoneybird({
      "POST /sales_invoices": ok(credit({ total_price_incl_tax: "-4.45" }), 201),
      [`PATCH /sales_invoices/${CREDIT_ID}/send_invoice`]: ok(credit({ state: "open", invoice_id: "2026-0044", total_price_incl_tax: "-4.45" })),
      [`POST /sales_invoices/${CREDIT_ID}/payments`]: ok({ id: "pay_3" }, 201),
    });
    await syncRefund(makeSwell() as any, makeSettings(), sent({ moneybird_refund_total: 50 }), refund);
    expect(bodyOf(fetchMock, "POST /sales_invoices").sales_invoice.details_attributes[0].price).toBe("-4.45");
  });

  it("finishes a credit invoice an earlier run made but didn't number or pay", async () => {
    const fetchMock = mockMoneybird({
      [`GET /sales_invoices/${CREDIT_ID}`]: ok(credit({ state: "draft" })),
      [`PATCH /sales_invoices/${CREDIT_ID}/send_invoice`]: ok(credit({ state: "open", invoice_id: "2026-0043", total_unpaid: "-10.0" })),
      [`POST /sales_invoices/${CREDIT_ID}/payments`]: ok({ id: "pay_2" }, 201),
    });
    const swell = makeSwell();
    const result = await syncRefund(swell as any, makeSettings(), sent({ moneybird_refunds: { [REFUND_ID]: CREDIT_ID } }), refund);
    expect(result).toEqual({ status: "sent", invoice_id: CREDIT_ID, done: ["refund"] });
    expect(callKeys(fetchMock)).toEqual([
      `GET /sales_invoices/${CREDIT_ID}`,
      `PATCH /sales_invoices/${CREDIT_ID}/send_invoice`,
      `POST /sales_invoices/${CREDIT_ID}/payments`,
    ]);
    expect(savedOn(swell, orderPath).moneybird_refunds_done).toEqual({ [REFUND_ID]: true });
  });

  it("doesn't pay back twice when an earlier run registered the payment", async () => {
    const fetchMock = mockMoneybird({
      [`GET /sales_invoices/${CREDIT_ID}`]: ok(credit({ state: "paid", invoice_id: "2026-0043", total_unpaid: "0.0" })),
    });
    await syncRefund(makeSwell() as any, makeSettings(), sent({ moneybird_refunds: { [REFUND_ID]: CREDIT_ID } }), refund);
    expect(callKeys(fetchMock)).toEqual([`GET /sales_invoices/${CREDIT_ID}`]);
  });

  it("books a negative external invoice for external orders", async () => {
    const fetchMock = mockMoneybird({
      "POST /external_sales_invoices": ok({ id: CREDIT_ID, state: "open", reference: "100546-R100015", total_price_incl_tax: "-10.0" }, 201),
      [`POST /external_sales_invoices/${CREDIT_ID}/payments`]: ok({ id: "pay_2" }, 201),
    });
    const swell = makeSwell();
    await syncRefund(swell as any, makeSettings(), sent({ moneybird_invoice_type: "external_sales_invoice" }), refund);
    expect(bodyOf(fetchMock, "POST /external_sales_invoices").external_sales_invoice.reference).toBe("100546-R100015");
    expect(savedOn(swell, orderPath).moneybird_credit_invoices).toBe("Refund 100015: external invoice 100546-R100015 (−10.00 EUR)");
  });

  it("skips orders not in Moneybird, refunds already sent and empty refunds", async () => {
    const fetchMock = mockMoneybird();
    expect(await syncRefund(makeSwell() as any, makeSettings(), makeOrder(), refund)).toEqual({ status: "skipped", reason: "the order isn't in Moneybird" });
    expect(await syncRefund(makeSwell() as any, makeSettings(), sent({ moneybird_refunds: { [REFUND_ID]: CREDIT_ID }, moneybird_refunds_done: { [REFUND_ID]: true } }), refund)).toEqual({
      status: "unchanged",
      reason: "refund already in Moneybird",
    });
    expect(await syncRefund(makeSwell() as any, makeSettings(), sent(), { id: "r", amount: 0 })).toEqual({ status: "skipped", reason: "refund amount is 0" });
    expect(await syncRefund(makeSwell() as any, makeSettings(), sent({ moneybird_refund_total: 54.45 }), refund)).toEqual({
      status: "skipped",
      reason: "order already fully refunded in Moneybird",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves the credit invoice before the next steps, so a retry doesn't create another", async () => {
    mockMoneybird({
      "POST /sales_invoices": ok(credit(), 201),
      [`PATCH /sales_invoices/${CREDIT_ID}/send_invoice`]: fail(503, "down"),
    });
    const swell = makeSwell();
    const result = await syncRefund(swell as any, makeSettings(), sent(), refund);
    expect(result).toMatchObject({ status: "failed", retry: true, reason: "Refund 100015: couldn't mark the credit invoice as sent: Moneybird is not available right now (Moneybird 503: down), try again later." });
    expect(savedOn(swell, orderPath).moneybird_refunds).toEqual({ [REFUND_ID]: CREDIT_ID });
  });
});

describe("subscription invoices", () => {
  const invoicePath = `/invoices/${SWELL_INVOICE_ID}`;
  const invoiceRoutes = {
    "GET /sales_invoices/find_by_reference/Invoice%20100021": fail(404, "record not found"),
    "GET /sales_invoices/find_by_reference/Test%20invoice%20100021": fail(404, "record not found"),
  };

  it("reads the invoice like an order: the subscription's addresses, its shipping total and item descriptions", () => {
    const invoice = forInvoice(makeSubscriptionInvoice({ items: [{ description: "Coffee subscription", price: 25, discount_each: 0.8, tax_each: 4.2, quantity: 2 }] }));
    expect(recordPath(invoice)).toBe(invoicePath);
    expect(recordPath(makeOrder())).toBe(orderPath);
    expect(orderLines(invoice)).toEqual([
      { description: "Coffee subscription", price: 24.2, amount: 2, percentage: 21 },
      { description: "Shipping – PostNL", price: 6.05, amount: 1, percentage: 21 },
    ]);
    expect(contactFields(invoice.account, invoice)).toMatchObject({ city: "Amsterdam", country: "NL", firstname: "Jane" });
    expect(orderReference(invoice)).toBe("Invoice 100021");
    expect(orderReference(invoice, "test")).toBe("Test invoice 100021");
    expect(externalReference(invoice)).toBe("INV-100021");
    expect(externalReference(makeOrder())).toBe("100546");
    // the customer's saved address when the invoice has no subscription
    const bare = forInvoice(makeSubscriptionInvoice({ subscription: null, account: { id: ACCOUNT_ID, billing: { city: "Utrecht" } } }));
    expect(bare.billing).toEqual({ city: "Utrecht" });
    expect(orderLines(bare)[1].description).toBe("Shipping");
  });

  it("skips void, unpaid and free invoices", () => {
    expect(orderSkipReason(forInvoice(makeSubscriptionInvoice({ void: true })))).toBe("invoice is void");
    expect(orderSkipReason(forInvoice(makeSubscriptionInvoice({ paid: false })))).toBe("invoice is not paid");
    expect(orderSkipReason(forInvoice(makeSubscriptionInvoice({ grand_total: 0 })))).toBe("invoice total is 0");
    expect(orderSkipReason(forInvoice(null))).toBe("invoice not found");
    expect(orderSkipReason(forInvoice(makeSubscriptionInvoice()))).toBeUndefined();
  });

  it("creates, numbers and pays a sales invoice for a paid subscription invoice, saved on the invoice", async () => {
    const fetchMock = mockMoneybird(invoiceRoutes);
    const swell = makeSwell({ payments: [{ date_created: "2026-11-01T06:05:00.000Z" }] });
    const result = await syncOrder(swell as any, makeSettings(), forInvoice(makeSubscriptionInvoice()), { adminUrl: "https://a" });

    expect(result).toEqual({ status: "sent", invoice_id: INVOICE_ID, done: ["created", "marked as sent", "payment registered"] });
    expect(callKeys(fetchMock)[0]).toBe("GET /sales_invoices/find_by_reference/Invoice%20100021");
    expect(bodyOf(fetchMock, "POST /sales_invoices")).toEqual({
      sales_invoice: {
        contact_id: CONTACT_ID,
        reference: "Invoice 100021",
        invoice_date: "2026-11-01",
        currency: "EUR",
        prices_are_incl_tax: true,
        details_attributes: [
          { description: "Tee – M", price: "24.20", amount: "2", tax_rate_id: "tr_21" },
          { description: "Shipping – PostNL", price: "6.05", amount: "1", tax_rate_id: "tr_21" },
        ],
      },
    });
    // the payment's date comes from the invoice's payments, not the order's
    expect(swell.get).toHaveBeenCalledWith("/payments", expect.objectContaining({ where: { invoice_id: SWELL_INVOICE_ID, success: true } }));
    expect(bodyOf(fetchMock, `POST /sales_invoices/${INVOICE_ID}/payments`)).toEqual({
      payment: { payment_date: "2026-11-01", price: "54.45", transaction_identifier: "Swell invoice 100021" },
    });
    expect(savedOn(swell, invoicePath)).toMatchObject({ moneybird_invoice_id: INVOICE_ID, moneybird_state: "paid", moneybird_error: null });
    expect(savedOn(swell, orderPath)).toEqual({});
    expect(savedOn(swell, `/accounts/${ACCOUNT_ID}`)).toMatchObject({ moneybird_contact_id: CONTACT_ID });
  });

  it("books an external sales invoice with a prefixed reference and a link to the invoice", async () => {
    const fetchMock = mockMoneybird({ "POST /external_sales_invoices": ok({ id: INVOICE_ID, state: "open", reference: "INV-100021", total_price_incl_tax: "54.45" }, 201) });
    const swell = makeSwell();
    await syncOrder(swell as any, makeSettings({ invoice_type: "external_sales_invoice" }), forInvoice(makeSubscriptionInvoice()), { adminUrl: "https://a/admin" });
    expect(bodyOf(fetchMock, "POST /external_sales_invoices").external_sales_invoice).toMatchObject({
      reference: "INV-100021",
      source_url: `https://a/admin/invoices/${SWELL_INVOICE_ID}`,
    });
    expect(savedOn(swell, invoicePath).moneybird_invoice_number).toBe("INV-100021");
  });

  it("books a refund of a subscription invoice as a credit invoice of the invoice", async () => {
    const credit = (overrides: Record<string, any> = {}) => makeInvoice({ id: CREDIT_ID, total_price_incl_tax: "-10.0", ...overrides });
    const fetchMock = mockMoneybird({
      "POST /sales_invoices": ok(credit(), 201),
      [`PATCH /sales_invoices/${CREDIT_ID}/send_invoice`]: ok(credit({ state: "open", invoice_id: "2026-0043", total_unpaid: "-10.0" })),
      [`POST /sales_invoices/${CREDIT_ID}/payments`]: ok({ id: "pay_2" }, 201),
    });
    const swell = makeSwell();
    const invoice = forInvoice(makeSubscriptionInvoice({ $app: { moneybird: { moneybird_invoice_id: INVOICE_ID, moneybird_invoice_type: "sales_invoice" } } }));
    const refund = { id: REFUND_ID, amount: 10, number: "100015", date_created: "2026-11-02T08:00:00.000Z" };
    const result = await syncRefund(swell as any, makeSettings(), invoice, refund, { adminUrl: "https://a/admin" });

    expect(result).toEqual({ status: "sent", invoice_id: CREDIT_ID, done: ["refund"] });
    expect(bodyOf(fetchMock, "POST /sales_invoices").sales_invoice).toMatchObject({
      reference: "Refund 100015 of invoice 100021",
      details_attributes: [{ description: "Refund of invoice 100021", price: "-10.00", amount: "1", tax_rate_id: "tr_21" }],
    });
    expect(bodyOf(fetchMock, `POST /sales_invoices/${CREDIT_ID}/payments`).payment.transaction_identifier).toBe("Swell refund 100015 of invoice 100021");
    expect(savedOn(swell, invoicePath)).toMatchObject({ moneybird_refunds_done: { [REFUND_ID]: true }, moneybird_refund_total: 10 });
  });

  it("gives an external credit invoice the prefixed reference too", async () => {
    const fetchMock = mockMoneybird({ "POST /external_sales_invoices": ok({ id: CREDIT_ID, state: "open", reference: "INV-100021-R100015", total_price_incl_tax: "-10.0" }, 201) });
    const invoice = forInvoice(makeSubscriptionInvoice({ $app: { moneybird: { moneybird_invoice_id: INVOICE_ID, moneybird_invoice_type: "external_sales_invoice" } } }));
    await syncRefund(makeSwell() as any, makeSettings({ register_payments: false }), invoice, { id: REFUND_ID, amount: 10, number: "100015" });
    expect(bodyOf(fetchMock, "POST /external_sales_invoices").external_sales_invoice.reference).toBe("INV-100021-R100015");
  });
});

describe("transaction identifier", () => {
  it("prefers the merchant's field, then the Swell payment's gateway ID, then the Swell number", () => {
    const order = makeOrder({ mollie_payment: { id: "tr_abc" }, metadata: { psp: 42 } });
    expect(transactionIdentifier(order, makeSettings({ transaction_id_field: "mollie_payment.id" }), { transaction_id: "pi_1" })).toBe("tr_abc");
    expect(transactionIdentifier(order, makeSettings({ transaction_id_field: "metadata.psp" }), null)).toBe("42");
    expect(transactionIdentifier(order, makeSettings({ transaction_id_field: "mollie_payment.missing" }), { transaction_id: "pi_1" })).toBe("pi_1");
    expect(transactionIdentifier(order, makeSettings(), { transaction_id: " " })).toBe("Swell order 100546");
    expect(transactionIdentifier(forInvoice(makeSubscriptionInvoice()), makeSettings(), null)).toBe("Swell invoice 100021");
  });

  it("registers the payment with the Swell payment's gateway ID, and the refund with the refund's", async () => {
    const fetchMock = mockMoneybird();
    const swell = makeSwell({ payments: [{ date_created: "2026-10-15T12:00:00.000Z", transaction_id: "tr_7GhY" }] });
    await syncOrder(swell as any, makeSettings(), makeOrder());
    expect(bodyOf(fetchMock, `POST /sales_invoices/${INVOICE_ID}/payments`).payment).toEqual({ payment_date: "2026-10-15", price: "54.45", transaction_identifier: "tr_7GhY" });

    vi.restoreAllMocks();
    const credit = (overrides: Record<string, any> = {}) => makeInvoice({ id: CREDIT_ID, total_price_incl_tax: "-10.0", ...overrides });
    const refundMock = mockMoneybird({
      "POST /sales_invoices": ok(credit(), 201),
      [`PATCH /sales_invoices/${CREDIT_ID}/send_invoice`]: ok(credit({ state: "open", invoice_id: "2026-0043", total_unpaid: "-10.0" })),
      [`POST /sales_invoices/${CREDIT_ID}/payments`]: ok({ id: "pay_2" }, 201),
    });
    const sent = withApp({ moneybird_invoice_id: INVOICE_ID, moneybird_invoice_type: "sales_invoice" });
    await syncRefund(makeSwell() as any, makeSettings(), sent, { id: REFUND_ID, amount: 10, number: "100015", transaction_id: "re_9" });
    expect(bodyOf(refundMock, `POST /sales_invoices/${CREDIT_ID}/payments`).payment.transaction_identifier).toBe("re_9");
  });

  it("reads the merchant's field on the order when the payment was made outside Swell", async () => {
    const fetchMock = mockMoneybird();
    await syncOrder(makeSwell() as any, makeSettings({ transaction_id_field: "mollie_payment.id" }), makeOrder({ mollie_payment: { id: "tr_abc" } }));
    expect(bodyOf(fetchMock, `POST /sales_invoices/${INVOICE_ID}/payments`).payment.transaction_identifier).toBe("tr_abc");
  });
});

describe("reference templates", () => {
  const templates = makeSettings({ order_reference: "orders-{number}", invoice_reference: "invoices-{number}" });

  it("fills {number}, adds it when missing, and marks test references", () => {
    expect(orderReference(makeOrder(), null, templates)).toBe("orders-100546");
    expect(orderReference(makeOrder(), "test", templates)).toBe("orders-100546 (test)");
    expect(orderReference(forInvoice(makeSubscriptionInvoice()), null, templates)).toBe("invoices-100021");
    expect(externalReference(makeOrder(), templates)).toBe("orders-100546");
    expect(externalReference(forInvoice(makeSubscriptionInvoice()), templates)).toBe("invoices-100021");
    expect(orderReference(makeOrder(), null, makeSettings({ order_reference: "SMPL" }))).toBe("SMPL 100546");
    // without templates nothing changes
    expect(orderReference(makeOrder(), "test", makeSettings())).toBe("Test order 100546");
    expect(externalReference(makeOrder(), makeSettings())).toBe("100546");
  });

  it("creates and finds the invoice by the template, and names credit invoices after it", async () => {
    const credit = (overrides: Record<string, any> = {}) => makeInvoice({ id: CREDIT_ID, total_price_incl_tax: "-10.0", ...overrides });
    const fetchMock = mockMoneybird({
      "GET /sales_invoices/find_by_reference/orders-100546": fail(404, "record not found"),
      [`PATCH /sales_invoices/${CREDIT_ID}/send_invoice`]: ok(credit({ state: "open", invoice_id: "2026-0043", total_unpaid: "-10.0" })),
      [`POST /sales_invoices/${CREDIT_ID}/payments`]: ok({ id: "pay_2" }, 201),
    });
    const swell = makeSwell();
    await syncOrder(swell as any, templates, makeOrder());
    expect(callKeys(fetchMock)[0]).toBe("GET /sales_invoices/find_by_reference/orders-100546");
    expect(bodyOf(fetchMock, "POST /sales_invoices").sales_invoice.reference).toBe("orders-100546");

    vi.restoreAllMocks();
    const refundMock = mockMoneybird({ "POST /sales_invoices": ok(credit(), 201), [`PATCH /sales_invoices/${CREDIT_ID}/send_invoice`]: ok(credit({ state: "open", invoice_id: "2026-0043", total_unpaid: "-10.0" })), [`POST /sales_invoices/${CREDIT_ID}/payments`]: ok({ id: "pay_2" }, 201) });
    const sent = withApp({ moneybird_invoice_id: INVOICE_ID, moneybird_invoice_type: "sales_invoice" });
    await syncRefund(makeSwell() as any, templates, sent, { id: REFUND_ID, amount: 10, number: "100015" });
    expect(bodyOf(refundMock, "POST /sales_invoices").sales_invoice.reference).toBe("Refund 100015 of orders-100546");
    expect(bodyOf(refundMock, `POST /sales_invoices/${CREDIT_ID}/payments`).payment.transaction_identifier).toBe("Swell refund 100015 of orders-100546");

    vi.restoreAllMocks();
    const externalMock = mockMoneybird({ "POST /external_sales_invoices": ok({ id: CREDIT_ID, state: "open", reference: "orders-100546-R100015", total_price_incl_tax: "-10.0" }, 201) });
    const external = withApp({ moneybird_invoice_id: INVOICE_ID, moneybird_invoice_type: "external_sales_invoice" });
    await syncRefund(makeSwell() as any, { ...templates, register_payments: false }, external, { id: REFUND_ID, amount: 10, number: "100015" });
    expect(bodyOf(externalMock, "POST /external_sales_invoices").external_sales_invoice.reference).toBe("orders-100546-R100015");
  });
});

describe("skip field", () => {
  it("skips orders and invoices with a value in the field, and sends the rest", async () => {
    const settings = makeSettings({ skip_field: "metadata.test" });
    expect(orderSkipReason(makeOrder({ metadata: { test: true } }), settings)).toBe("metadata.test is set on the order");
    expect(orderSkipReason(makeOrder({ metadata: { test: "yes" } }), settings)).toBe("metadata.test is set on the order");
    expect(orderSkipReason(forInvoice(makeSubscriptionInvoice({ metadata: { test: 1 } })), settings)).toBe("metadata.test is set on the invoice");
    for (const metadata of [undefined, { test: false }, { test: "" }, { test: null }, { test: [] }]) {
      expect(orderSkipReason(makeOrder({ metadata }), settings)).toBeUndefined();
    }
    expect(orderSkipReason(makeOrder({ metadata: { test: true } }), makeSettings())).toBeUndefined();

    const fetchMock = mockMoneybird();
    const swell = makeSwell();
    const result = await syncOrder(swell as any, settings, makeOrder({ metadata: { test: true } }));
    expect(result).toEqual({ status: "skipped", reason: "metadata.test is set on the order" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(swell.put).not.toHaveBeenCalled();
  });
});
