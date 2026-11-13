import {
  APP_ID,
  MoneybirdError,
  SwellReadError,
  appData,
  appValues,
  connectionError,
  day,
  matchTaxRate,
  moneybirdRequest,
  money,
  orderUrl,
  salesTaxRates,
  webUrl,
  type MoneybirdSettings,
  type SwellClient,
  type TaxRate,
} from './moneybird';

export const ORDER_EXPAND = ['account', 'items.product', 'items.variant'];

// the source name shown on external sales invoices
export const SOURCE = 'Swell';

export interface SyncOptions {
  appId?: string;
  // Swell dashboard address (with /admin or /admin/test), for the link back to the order on external sales invoices
  adminUrl?: string;
  // "test" in the test environment: its invoices get their own reference, so a live invoice is never taken for one
  env?: 'test' | null;
  // tax rates loaded once for a batch of orders
  taxRates?: TaxRate[];
  // date of the payment; when not given, the date of the order's last successful Swell payment
  paymentDate?: string;
}

export type SyncResult =
  | { status: 'sent'; invoice_id: string; done: string[] }
  | { status: 'updated'; invoice_id: string; done: string[] }
  | { status: 'unchanged'; reason: string }
  | { status: 'skipped'; reason: string }
  // retry: whether running it again can't create a second document
  | { status: 'failed'; reason: string; error: unknown; retry: boolean };

// save the app's values; a failed save is only logged, so the invoice isn't created twice because of it
async function saveValues(swell: SwellClient, path: string, values: Record<string, any>, appId: string) {
  try {
    await swell.put(path, appValues(values, appId));
  } catch (err) {
    console.error(`Moneybird: could not save ${Object.keys(values).join(', ')} on ${path} - ${err instanceof Error ? err.message : err}`);
  }
}

// --- contacts ---

function clean(values: Record<string, any>) {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined && v !== null && v !== ''));
}

// Moneybird contact fields from a Swell customer, with the order's billing details when there's an order
export function contactFields(account: any, order?: any): Record<string, any> {
  // the order's empty billing fields (method "account") don't replace the customer's saved ones
  const billing = { ...clean(account?.billing || {}), ...clean(order?.billing || {}) };
  const address = billing.address1 || billing.city ? billing : { ...(order?.shipping || account?.shipping || {}), ...clean(billing) };
  const email = account?.email || order?.billing?.email;
  const firstname = account?.first_name || address.first_name;
  const lastname = account?.last_name || address.last_name;
  const company = address.company;
  return clean({
    customer_id: account?.id,
    company_name: company || (!firstname && !lastname ? account?.name || email : undefined),
    firstname,
    lastname,
    address1: address.address1,
    address2: address.address2,
    zipcode: address.zip,
    city: address.city,
    country: address.country ? String(address.country).toUpperCase() : undefined,
    phone: account?.phone || address.phone,
    send_invoices_to_email: email,
    delivery_method: email ? 'Email' : undefined,
    tax_number: account?.vat_number || billing.vat_number,
  });
}

// the customer's Moneybird contact, by Swell customer ID; null when there's none
export async function findContact(settings: MoneybirdSettings, customerId: string): Promise<any | null> {
  try {
    return await moneybirdRequest(settings, 'GET', `/contacts/customer_id/${encodeURIComponent(customerId)}`);
  } catch (err) {
    // only this lookup's 404 means "no contact"; other 404s (wrong administration) are real errors
    if (err instanceof MoneybirdError && err.status === 404 && !/administration/i.test(err.message)) {
      return null;
    }
    throw err;
  }
}

// Moneybird adds a contact person for every new firstname/lastname sent to a contact; rename the person with the
// contact's current name first, so a changed name updates that person instead of adding another one
export async function renameContactPerson(settings: MoneybirdSettings, contact: any, fields: Record<string, any>): Promise<void> {
  const same = (a: unknown, b: unknown) => (a || '') === (b || '');
  const firstname = fields.firstname ?? contact?.firstname;
  const lastname = fields.lastname ?? contact?.lastname;
  if (same(firstname, contact?.firstname) && same(lastname, contact?.lastname)) {
    return;
  }
  const people: any[] = Array.isArray(contact?.contact_people) ? contact.contact_people : [];
  if (people.some((person) => same(person.firstname, firstname) && same(person.lastname, lastname))) {
    return;
  }
  const person = people.find((person) => same(person.firstname, contact.firstname) && same(person.lastname, contact.lastname));
  if (!person) {
    return;
  }
  await moneybirdRequest(settings, 'PATCH', `/contacts/${contact.id}/contact_people/${person.id}`, {
    contact_person: { firstname: firstname || null, lastname: lastname || null },
  });
}

// Moneybird refused the contact's email: it checks that the domain can receive mail
export function isEmailRefused(err: unknown): boolean {
  return err instanceof MoneybirdError && err.status === 422 && /send_invoices_to_email/.test(err.message);
}

// contact fields without the email, for an address Moneybird refuses
export function withoutEmail(fields: Record<string, any>): Record<string, any> {
  const { send_invoices_to_email, delivery_method, ...rest } = fields;
  return { ...rest, delivery_method: 'Manual' };
}

export const EMAIL_REFUSED_NOTE =
  "Moneybird refused the customer's email (its domain can't receive mail), so the contact has no invoice email.";

// find the order's customer in Moneybird, or create the contact; emailRefused when it was created without the email
export async function ensureContact(
  swell: SwellClient,
  settings: MoneybirdSettings,
  order: any,
  appId: string,
): Promise<{ id: string; emailRefused: boolean }> {
  const account = order.account || { id: order.account_id };
  const customerId = String(account.id || order.account_id || `order-${order.id}`);
  const existing = await findContact(settings, customerId);
  let contactId = existing?.id ? String(existing.id) : '';
  let emailRefused = false;
  if (!contactId) {
    const fields = { ...contactFields(account, order), customer_id: customerId };
    let created;
    try {
      created = await moneybirdRequest(settings, 'POST', '/contacts', { contact: fields });
    } catch (err) {
      if (!isEmailRefused(err)) throw err;
      created = await moneybirdRequest(settings, 'POST', '/contacts', { contact: withoutEmail(fields) });
      emailRefused = true;
    }
    contactId = String(created.id);
  }
  if (account.id && appData(account, appId).moneybird_contact_id !== contactId) {
    await saveValues(
      swell,
      `/accounts/${account.id}`,
      { moneybird_contact_id: contactId, moneybird_contact_url: webUrl(settings, 'contacts', contactId) },
      appId,
    );
  }
  return { id: contactId, emailRefused };
}

// --- invoice lines ---

export interface Line {
  description: string;
  price: number;
  amount: number;
  // tax percentage Swell charged on the line
  percentage: number;
}

const percentageOf = (tax: number, net: number) => (net > 0 ? Math.round((tax / net) * 10000) / 100 : 0);

// order lines with unit prices in the order's price basis (incl. tax when the store's prices include tax)
export function orderLines(order: any): Line[] {
  const inclTax = Boolean(order.item_tax_included);
  const lines: Line[] = (order.items || []).map((item: any) => {
    const unit = Number(item.price || 0) - Number(item.discount_each || 0);
    const tax = Number(item.tax_each || 0);
    const net = inclTax ? unit - tax : unit;
    const name = item.product?.name || item.product_name || 'Product';
    const variant = item.variant?.name;
    return {
      description: variant ? `${name} – ${variant}` : name,
      price: money(unit),
      amount: Number(item.quantity) || 1,
      percentage: percentageOf(tax, net),
    };
  });

  const shippingTax = Number(order.shipment_tax || 0);
  let shipping = Number(order.shipment_price || 0) - Number(order.shipment_discount || 0);
  if (shipping > 0) {
    // shipping can be priced on another basis than the items
    const shippingInclTax = Boolean(order.shipment_tax_included);
    if (inclTax && !shippingInclTax) shipping += shippingTax;
    if (!inclTax && shippingInclTax) shipping -= shippingTax;
    const net = inclTax ? shipping - shippingTax : shipping;
    lines.push({
      description: order.shipping?.service_name ? `Shipping – ${order.shipping.service_name}` : 'Shipping',
      price: money(shipping),
      amount: 1,
      percentage: percentageOf(shippingTax, net),
    });
  }
  return lines;
}

// refund lines: one per tax percentage, for the refunded share of the order
export function refundLines(order: any, amount: number): Line[] {
  const lines = orderLines(order);
  const total = money(order.grand_total);
  const refunded = total > 0 ? Math.min(money(amount), total) : money(amount);
  const ratio = total > 0 ? refunded / total : 1;
  const byRate = new Map<number, number>();
  for (const line of lines) {
    byRate.set(line.percentage, (byRate.get(line.percentage) || 0) + line.price * line.amount);
  }
  const result = [...byRate.entries()].map(([percentage, sum]) => ({
    description: `Refund of order ${order.number}${byRate.size > 1 ? ` (${percentage}% tax)` : ''}`,
    price: -money(sum * ratio),
    amount: 1,
    percentage,
  }));
  // prices that include tax add up to the refund exactly: put the rounding difference on the last line
  if (order.item_tax_included && result.length) {
    const diff = money(-refunded - result.reduce((s, l) => s + l.price, 0));
    result[result.length - 1].price = money(result[result.length - 1].price + diff);
  }
  return result;
}

// Moneybird details: each line with the tax rate of its percentage, else the default tax rate
export function detailsAttributes(lines: Line[], rates: TaxRate[], settings: MoneybirdSettings, country?: string) {
  const unmatched: number[] = [];
  const details = lines.map((line) => {
    const rate = matchTaxRate(rates, line.percentage, country);
    if (!rate && !unmatched.includes(line.percentage)) unmatched.push(line.percentage);
    return clean({
      description: line.description,
      price: line.price.toFixed(2),
      amount: String(line.amount),
      tax_rate_id: rate?.id || settings.default_tax_rate_id || undefined,
      ledger_account_id: settings.ledger_account_id || undefined,
    });
  });
  return { details, unmatched };
}

// --- invoices ---

const invoiceKind = (type: string) => (type === 'external_sales_invoice' ? 'external_sales_invoices' : 'sales_invoices');

// the sales invoice's reference, which also finds an invoice an earlier run made but didn't save; test and live
// orders can share numbers (and an administration), so test invoices get their own
export function orderReference(order: any, env?: 'test' | null) {
  return `${env === 'test' ? 'Test order' : 'Order'} ${order.number}`;
}

// Every document made in the test environment gets "Test" in its reference, so in an administration shared with live
// it stands apart from live documents (and a test order never matches a live one with the same number).
export function documentReference(type: string, order: any, env?: 'test' | null) {
  if (type === 'sales_invoice') return orderReference(order, env);
  return `${env === 'test' ? 'Test ' : ''}${order.number}`;
}

export function refundReference(type: string, order: any, refund: { id: string; number?: string }, env?: 'test' | null) {
  const test = env === 'test';
  if (type === 'sales_invoice') {
    // "Refund 2 of order 100546", in test "Test refund 2 of order 100546"
    const label = `${test ? 'Test refund' : 'Refund'}${refund.number ? ` ${refund.number}` : ''}`;
    return `${label} of order ${order.number}`;
  }
  return `${test ? 'Test ' : ''}${order.number}-R${refund.number || String(refund.id).slice(-6)}`;
}

// the day of the order's last successful Swell payment, the same on every retry; the order date when it has none
export async function paymentDay(swell: Pick<SwellClient, 'get'>, order: any): Promise<string> {
  let found: any;
  try {
    found = await swell.get('/payments', {
      where: { order_id: order.id, success: true },
      sort: 'date_created desc',
      limit: 1,
      fields: 'date_created',
    });
  } catch (err) {
    throw new SwellReadError("the order's payments", err);
  }
  const paidAt = found?.results?.[0]?.date_created;
  return day(paidAt || order.date_created);
}

interface DocumentInput {
  contactId: string;
  reference: string;
  date: string;
  currency: string;
  inclTax: boolean;
  details: Record<string, any>[];
  sourceUrl?: string;
}

// create a sales invoice (a draft) or an external sales invoice (open)
async function createDocument(settings: MoneybirdSettings, input: DocumentInput): Promise<any> {
  if (settings.invoice_type === 'external_sales_invoice') {
    return moneybirdRequest(settings, 'POST', '/external_sales_invoices', {
      external_sales_invoice: clean({
        contact_id: input.contactId,
        reference: input.reference,
        date: input.date,
        currency: input.currency,
        prices_are_incl_tax: input.inclTax,
        source: SOURCE,
        source_url: input.sourceUrl,
        details_attributes: input.details,
      }),
    });
  }
  return moneybirdRequest(settings, 'POST', '/sales_invoices', {
    sales_invoice: clean({
      contact_id: input.contactId,
      reference: input.reference,
      invoice_date: input.date,
      currency: input.currency,
      prices_are_incl_tax: input.inclTax,
      workflow_id: settings.workflow_id || undefined,
      document_style_id: settings.document_style_id || undefined,
      details_attributes: input.details,
    }),
  });
}

// give a draft sales invoice its number: mark it as sent, or email it to the customer
async function finalizeInvoice(settings: MoneybirdSettings, invoiceId: string): Promise<any> {
  return moneybirdRequest(settings, 'PATCH', `/sales_invoices/${invoiceId}/send_invoice`, {
    sales_invoice_sending: { delivery_method: settings.finalize === 'email' ? 'Email' : 'Manual' },
  });
}

// what's left to pay on the invoice (negative on a credit invoice), in its currency and in the administration's
export function unpaidOf(invoice: any): { price: number; base: number | undefined } {
  const price = Number(invoice?.total_unpaid ?? invoice?.total_price_incl_tax);
  const base = Number(invoice?.total_unpaid_base ?? invoice?.total_price_incl_tax_base);
  return { price: Number.isFinite(price) ? money(price) : NaN, base: Number.isFinite(base) ? money(base) : undefined };
}

// price_base, the amount in the administration's currency, is required for invoices in another currency
async function registerPayment(
  settings: MoneybirdSettings,
  invoiceId: string,
  amount: { price: number; base?: number },
  date: string,
  transaction?: string,
) {
  return moneybirdRequest(settings, 'POST', `/${invoiceKind(settings.invoice_type)}/${invoiceId}/payments`, {
    payment: clean({
      payment_date: date,
      price: amount.price.toFixed(2),
      price_base: amount.base !== undefined ? amount.base.toFixed(2) : undefined,
      transaction_identifier: transaction,
      financial_account_id: settings.financial_account_id || undefined,
      manual_payment_action: settings.payment_without_proof ? 'payment_without_proof' : undefined,
    }),
  });
}

const STATE_LABELS: Record<string, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  open: 'Open',
  pending_payment: 'Pending payment',
  reminded: 'Reminded',
  late: 'Late',
  paid: 'Paid',
  uncollectible: 'Uncollectible',
};

export const stateLabel = (state: unknown) => STATE_LABELS[String(state)] || String(state || '');

// why an order isn't sent, or undefined when it can be
export function orderSkipReason(order: any): string | undefined {
  if (!order?.id) return 'order not found';
  if (order.draft) return 'order is a draft';
  if (!order.paid) return 'order is not paid';
  if (!(Number(order.grand_total) > 0)) return 'order total is 0';
  return undefined;
}

// Create the order's invoice, give it its number and register the payment. Each step is saved on the
// order, so a retry continues where the last run stopped instead of creating a second invoice.
export async function syncOrder(swell: SwellClient, settings: MoneybirdSettings, order: any, options: SyncOptions = {}): Promise<SyncResult> {
  const appId = options.appId || APP_ID;
  const path = `/orders/${order?.id}`;
  const reason = orderSkipReason(order);
  if (reason) {
    return { status: 'skipped', reason };
  }

  const saved = appData(order, appId);
  // invoice type when the invoice was created; a later settings change doesn't apply to it
  const type = saved.moneybird_invoice_type || settings.invoice_type;
  const typed = { ...settings, invoice_type: type } as MoneybirdSettings;
  let invoiceId: string = saved.moneybird_invoice_id || '';
  let state: string = saved.moneybird_state || '';
  const done: string[] = [];
  // The step a failure is reported under. Only a failure in the step "create the invoice" can leave a document behind,
  // so the calls before it (lookup, contact, tax rates) have their own steps and their temporary errors are retried.
  const step = { name: 'look for an existing invoice' };

  try {
    if (!invoiceId && type === 'sales_invoice') {
      // an invoice made by an earlier run whose result wasn't saved
      const found = await findByReference(typed, orderReference(order, options.env));
      if (found?.id) {
        invoiceId = String(found.id);
        state = found.state;
        await saveValues(swell, path, invoiceValues(typed, found), appId);
      }
    }

    if (!invoiceId) {
      step.name = 'find or create the contact';
      const contact = await ensureContact(swell, typed, order, appId);
      const contactId = contact.id;
      step.name = 'load the tax rates';
      const rates = options.taxRates ?? (await salesTaxRates(typed));
      const { details, unmatched } = detailsAttributes(orderLines(order), rates, typed, order.billing?.country || order.shipping?.country);
      step.name = 'create the invoice';
      const invoice = await createDocument(typed, {
        contactId,
        reference: documentReference(type, order, options.env),
        date: day(order.date_created),
        currency: order.currency,
        inclTax: Boolean(order.item_tax_included),
        details,
        sourceUrl: orderUrl(options.adminUrl, order.id),
      });
      invoiceId = String(invoice.id);
      state = invoice.state;
      done.push('created');
      await saveValues(
        swell,
        path,
        {
          ...invoiceValues(typed, invoice),
          moneybird_note: [contact.emailRefused ? EMAIL_REFUSED_NOTE : null, totalNote(order, invoice, unmatched, typed)].filter(Boolean).join(' ') || null,
        },
        appId,
      );
    }

    if (type === 'sales_invoice' && state === 'draft' && settings.finalize !== 'draft') {
      step.name = settings.finalize === 'email' ? 'email the invoice' : 'mark the invoice as sent';
      const invoice = await finalizeInvoice(typed, invoiceId);
      state = invoice.state;
      done.push(settings.finalize === 'email' ? 'emailed' : 'marked as sent');
      await saveValues(swell, path, invoiceValues(typed, invoice), appId);
    }

    if (settings.register_payments && !saved.moneybird_paid_at && state !== 'draft' && state !== 'paid') {
      step.name = 'register the payment';
      const invoice = await moneybirdRequest(typed, 'GET', `/${invoiceKind(type)}/${invoiceId}`);
      const unpaid = unpaidOf(invoice);
      if (unpaid.price > 0) {
        const paidOn = options.paymentDate || (await paymentDay(swell, order));
        await registerPayment(typed, invoiceId, unpaid, paidOn, `Swell order ${order.number}`);
        done.push('payment registered');
      }
      await saveValues(swell, path, { moneybird_paid_at: new Date().toISOString(), moneybird_state: 'paid', moneybird_status: stateLabel('paid'), moneybird_error: null }, appId);
      state = 'paid';
    }
  } catch (err) {
    const message = `Couldn't ${step.name}: ${connectionError(err)}`;
    await saveValues(swell, path, { moneybird_error: message }, appId);
    // a sales invoice made by a failed call is found by its reference next time; an external one isn't
    const creating = step.name === 'create the invoice' && !invoiceId && type === 'external_sales_invoice';
    return { status: 'failed', reason: message, error: err, retry: !creating || notProcessed(err) };
  }

  if (!done.length) {
    return { status: 'unchanged', reason: 'already in Moneybird' };
  }
  await saveValues(swell, path, { moneybird_error: null }, appId);
  return done.includes('created') ? { status: 'sent', invoice_id: invoiceId, done } : { status: 'updated', invoice_id: invoiceId, done };
}

async function findByReference(settings: MoneybirdSettings, reference: string): Promise<any | null> {
  try {
    return await moneybirdRequest(settings, 'GET', `/sales_invoices/find_by_reference/${encodeURIComponent(reference)}`);
  } catch (err) {
    if (err instanceof MoneybirdError && err.status === 404 && !/administration/i.test(err.message)) {
      return null;
    }
    throw err;
  }
}

// the invoice's ID, number, link and state, saved on the order
function invoiceValues(settings: MoneybirdSettings, invoice: any): Record<string, any> {
  const id = String(invoice.id);
  const external = settings.invoice_type === 'external_sales_invoice';
  return {
    moneybird_invoice_id: id,
    moneybird_invoice_type: settings.invoice_type,
    moneybird_invoice_number: external ? invoice.reference || null : invoice.invoice_id || null,
    // the invoice's own url is the customer's public view; link to it in the Moneybird admin instead
    moneybird_invoice_url: webUrl(settings, external ? 'external_sales_invoices' : 'sales_invoices', id),
    moneybird_state: invoice.state || null,
    moneybird_status: stateLabel(invoice.state) || null,
  };
}

// a note when Moneybird's total differs from Swell's, or a tax rate had no match
function totalNote(order: any, invoice: any, unmatched: number[], settings: MoneybirdSettings): string | null {
  const notes: string[] = [];
  if (unmatched.length) {
    notes.push(
      `No Moneybird sales tax rate of ${unmatched.map((p) => `${p}%`).join(', ')}: ` +
        (settings.default_tax_rate_id ? 'used the default tax rate from the app settings.' : "used the administration's default tax rate."),
    );
  }
  const total = Number(invoice?.total_price_incl_tax);
  if (Number.isFinite(total) && Math.abs(total - money(order.grand_total)) >= 0.01) {
    notes.push(`The Moneybird total ${total.toFixed(2)} differs from the Swell total ${money(order.grand_total).toFixed(2)}.`);
  }
  return notes.length ? notes.join(' ') : null;
}

// --- refunds ---

// Send a Swell refund as a credit invoice (sales invoices) or a negative external invoice, once per refund
export async function syncRefund(
  swell: SwellClient,
  settings: MoneybirdSettings,
  order: any,
  refund: { id: string; amount: unknown; number?: string; date_created?: string },
  options: SyncOptions = {},
): Promise<SyncResult> {
  const appId = options.appId || APP_ID;
  const saved = appData(order, appId);
  const refundId = String(refund.id);
  if (!saved.moneybird_invoice_id) return { status: 'skipped', reason: "the order isn't in Moneybird" };
  if (saved.moneybird_refunds_done?.[refundId]) return { status: 'unchanged', reason: 'refund already in Moneybird' };
  // a credit invoice an earlier run made but didn't finish (not numbered or not paid)
  const existingId: string | undefined = saved.moneybird_refunds?.[refundId];
  // never more than the part of the order not refunded in Moneybird yet
  const amount = money(Math.min(money(refund.amount), money(order.grand_total) - money(saved.moneybird_refund_total)));
  if (!(amount > 0)) return { status: 'skipped', reason: money(refund.amount) > 0 ? 'order already fully refunded in Moneybird' : 'refund amount is 0' };

  const type = saved.moneybird_invoice_type || settings.invoice_type;
  const typed = { ...settings, invoice_type: type } as MoneybirdSettings;
  const path = `/orders/${order.id}`;
  const step = { name: 'create the credit invoice' };
  const label = refund.number ? `Refund ${refund.number}` : 'Refund';

  try {
    let invoice: any;
    if (existingId) {
      step.name = 'finish the credit invoice';
      invoice = await moneybirdRequest(typed, 'GET', `/${invoiceKind(type)}/${existingId}`);
    } else {
      // as in syncOrder, only the step "create the credit invoice" can leave a document behind
      step.name = 'find or create the contact';
      const { id: contactId } = await ensureContact(swell, typed, order, appId);
      step.name = 'load the tax rates';
      const rates = options.taxRates ?? (await salesTaxRates(typed));
      const { details } = detailsAttributes(refundLines(order, amount), rates, typed, order.billing?.country || order.shipping?.country);
      step.name = 'create the credit invoice';
      invoice = await createDocument(typed, {
        contactId,
        reference: refundReference(type, order, { id: refundId, number: refund.number }, options.env),
        date: day(refund.date_created),
        currency: order.currency,
        inclTax: Boolean(order.item_tax_included),
        details,
        sourceUrl: orderUrl(options.adminUrl, order.id),
      });
      // saved first, so a retry finishes this credit invoice instead of creating a second one
      await saveValues(swell, path, { moneybird_refunds: { [refundId]: String(invoice.id) } }, appId);
    }
    const creditId = String(invoice.id ?? existingId);

    if (type === 'sales_invoice' && invoice.state === 'draft' && settings.finalize !== 'draft') {
      step.name = settings.finalize === 'email' ? 'email the credit invoice' : 'mark the credit invoice as sent';
      invoice = await finalizeInvoice(typed, creditId);
    }
    if (settings.register_payments && invoice.state !== 'draft') {
      step.name = 'register the refund payment';
      const unpaid = unpaidOf(invoice);
      // nothing left to pay back: the payment was registered by an earlier run
      const due = Number.isNaN(unpaid.price) ? { price: -amount, base: undefined } : unpaid.price < 0 ? unpaid : null;
      if (due) {
        await registerPayment(typed, creditId, due, day(refund.date_created), `Swell ${label.toLowerCase()} of order ${order.number}`);
      }
    }

    const number = type === 'sales_invoice' ? invoice.invoice_id || 'draft' : invoice.reference;
    const line = `${label}: ${type === 'sales_invoice' ? 'credit invoice' : 'external invoice'} ${number} (−${amount.toFixed(2)} ${order.currency})`;
    await saveValues(
      swell,
      path,
      {
        moneybird_refund_total: money(Number(saved.moneybird_refund_total || 0) + amount),
        moneybird_credit_invoices: [saved.moneybird_credit_invoices, line].filter(Boolean).join('\n'),
        moneybird_refunds_done: { [refundId]: true },
        moneybird_error: null,
      },
      appId,
    );
    return { status: 'sent', invoice_id: creditId, done: ['refund'] };
  } catch (err) {
    const message = `${label}: couldn't ${step.name}: ${connectionError(err)}`;
    await saveValues(swell, path, { moneybird_error: message }, appId);
    // a credit invoice made by a failed call can't be found again, so only a refused call is retried;
    // later steps are retried, and the next run finishes the saved credit invoice
    return { status: 'failed', reason: message, error: err, retry: step.name !== 'create the credit invoice' || notProcessed(err) };
  }
}

// Moneybird refused the call before doing anything (rate limit), so it can be made again
function notProcessed(err: unknown): boolean {
  return err instanceof MoneybirdError && err.status === 429;
}

// network errors, rate limits, outages and failed Swell reads are rethrown so Swell runs the event again; that's safe
// because each finished step is saved on the order and skipped next time
export function retryIfTemporary(result: SyncResult) {
  if (isTemporary(result)) throw (result as { error: unknown }).error;
}

// a failed result that running again can fix: a Moneybird outage or rate limit, or a failed Swell read
export function isTemporary(result: SyncResult): boolean {
  if (result.status !== 'failed' || !result.retry) return false;
  const err = result.error;
  return err instanceof SwellReadError || (err instanceof MoneybirdError && err.retryable);
}

export function logResult(what: string, result: SyncResult) {
  switch (result.status) {
    case 'sent':
    case 'updated':
      console.log(`Moneybird: ${what} - ${result.done.join(', ')} (${result.invoice_id})`);
      break;
    case 'failed':
      console.error(`Moneybird: ${what} failed - ${result.error instanceof MoneybirdError ? result.error.detail : result.reason}`);
      break;
    default:
      console.log(`Moneybird: ${what} not sent - ${result.reason}`);
  }
}
