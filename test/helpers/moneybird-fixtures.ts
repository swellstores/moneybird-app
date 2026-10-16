import { vi } from "vitest";
import { getSettings, type MoneybirdSettings } from "../../functions/lib/moneybird";

export const ADMIN = "123456789012345678";

// raw settings as returned by swell.settings()
export const rawSettings = {
  api_token: "mb_token",
  administration_id: ADMIN,
};

export function makeSettings(overrides: Partial<MoneybirdSettings> = {}): MoneybirdSettings {
  return { ...getSettings({ moneybird: rawSettings }), ...overrides };
}

export const ADMIN_URL = "https://shop.swell.store/admin";
export const ORDER_ID = "6ad0bd84dfd3c8001209250f";
export const ACCOUNT_ID = "6abf95ed455bb60012798bfa";
export const REFUND_ID = "6acf741edb7b280012017602";
export const CONTACT_ID = "501000000000000001";
export const INVOICE_ID = "501000000000000002";
export const CREDIT_ID = "501000000000000003";

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: ORDER_ID,
    number: "100546",
    date_created: "2026-10-15T11:48:23.000Z",
    currency: "EUR",
    paid: true,
    item_tax_included: true,
    // 2 × 24.20 incl. 21% + shipping 6.05 incl. 21%
    grand_total: 54.45,
    shipment_price: 5,
    shipment_tax: 1.05,
    shipment_tax_included: false,
    account_id: ACCOUNT_ID,
    account: { id: ACCOUNT_ID, email: "jane@example.com", first_name: "Jane", last_name: "Doe" },
    billing: { address1: "Hoofdstraat 1", zip: "1234AB", city: "Amsterdam", country: "nl" },
    shipping: { service_name: "PostNL" },
    items: [{ product_id: "p1", product: { name: "Tee" }, variant: { name: "M" }, price: 25, discount_each: 0.8, tax_each: 4.2, quantity: 2 }],
    ...overrides,
  };
}

export const TAX_RATES = [
  { id: "tr_21", name: "21% btw", percentage: "21.0", tax_rate_type: "sales_invoice", active: true, country: null },
  { id: "tr_9", name: "9% btw", percentage: "9.0", tax_rate_type: "sales_invoice", active: true, country: null },
  { id: "tr_old", name: "19% oud", percentage: "19.0", tax_rate_type: "sales_invoice", active: false, country: null },
];

export function makeInvoice(overrides: Record<string, any> = {}) {
  return {
    id: INVOICE_ID,
    invoice_id: null,
    state: "draft",
    reference: "Order 100546",
    total_price_incl_tax: "54.45",
    total_unpaid: "54.45",
    url: `https://moneybird.com/${ADMIN}/sales_invoices/${INVOICE_ID}`,
    ...overrides,
  };
}

export type Reply = { status: number; body?: any } | Error;
export const ok = (body: any, status = 200): Reply => ({ status, body });
export const fail = (status: number, error: any = "error"): Reply => ({ status, body: { error } });

function respond(reply: Reply): Response {
  if (reply instanceof Error) {
    throw reply;
  }
  return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status });
}

// routes: "METHOD /path" (without /api/v2/<administration> and .json) → reply
export type Routes = Record<string, Reply | Reply[]>;

const DEFAULT_ROUTES: Routes = {
  "GET /administrations": ok([{ id: ADMIN, name: "Alder BV", currency: "EUR" }]),
  "GET /tax_rates": ok(TAX_RATES),
  "GET /financial_accounts": ok([{ id: "fa_1", name: "Mollie", type: "PaymentServiceProvider" }]),
  [`GET /contacts/customer_id/${ACCOUNT_ID}`]: ok({ id: CONTACT_ID }),
  "POST /contacts": ok({ id: CONTACT_ID }, 201),
  [`GET /contacts/${CONTACT_ID}`]: ok({ id: CONTACT_ID }),
  [`PATCH /contacts/${CONTACT_ID}`]: ok({ id: CONTACT_ID }),
  "GET /sales_invoices/find_by_reference/Order%20100546": fail(404, "record not found"),
  "POST /sales_invoices": ok(makeInvoice(), 201),
  [`PATCH /sales_invoices/${INVOICE_ID}/send_invoice`]: ok(makeInvoice({ state: "open", invoice_id: "2026-0042" })),
  [`GET /sales_invoices/${INVOICE_ID}`]: ok(makeInvoice({ state: "open", invoice_id: "2026-0042" })),
  [`POST /sales_invoices/${INVOICE_ID}/payments`]: ok({ id: "pay_1" }, 201),
  "POST /external_sales_invoices": ok({ id: INVOICE_ID, state: "open", reference: "100546", total_price_incl_tax: "54.45" }, 201),
  [`GET /external_sales_invoices/${INVOICE_ID}`]: ok({ id: INVOICE_ID, state: "open", total_unpaid: "54.45" }),
  [`POST /external_sales_invoices/${INVOICE_ID}/payments`]: ok({ id: "pay_1" }, 201),
};

// Mocks global fetch by Moneybird endpoint; list replies are taken in order (the last one repeats)
export function mockMoneybird(routes: Routes = {}) {
  const all: Routes = { ...DEFAULT_ROUTES, ...routes };
  const queues = new Map(Object.entries(all).map(([key, reply]) => [key, Array.isArray(reply) ? [...reply] : [reply]]));
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const key = `${init?.method || "GET"} ${endpointOf(String(input))}`;
    const queue = queues.get(key);
    if (!queue) throw new Error(`unexpected fetch ${key}`);
    return respond(queue.length > 1 ? queue.shift()! : queue[0]);
  });
}

function endpointOf(url: string) {
  const path = new URL(url).pathname.replace(/^\/api\/v2/, "").replace(/\.json$/, "");
  return path === "/administrations" ? path : path.replace(/^\/[^/]+/, "");
}

// method, path, headers and parsed body of each call
export function calls(fetchMock: { mock: { calls: any[][] } }) {
  return fetchMock.mock.calls.map(([url, init]) => ({
    key: `${init?.method || "GET"} ${endpointOf(String(url))}`,
    url: String(url),
    headers: init?.headers || {},
    body: init?.body ? JSON.parse(init.body) : undefined,
  }));
}

export const callKeys = (fetchMock: { mock: { calls: any[][] } }) => calls(fetchMock).map((c) => c.key);
export const bodyOf = (fetchMock: { mock: { calls: any[][] } }, key: string) => calls(fetchMock).find((c) => c.key === key)?.body;

// Swell client mock: get answers by path, put records writes
export function makeSwell(records: Record<string, any> = {}, settings: any = rawSettings) {
  const pages: any[][] = [...(records.pages ?? [])];
  return {
    get: vi.fn(async (path: string, query?: any) => {
      if (path === `/orders/${ORDER_ID}`) return "order" in records ? records.order : makeOrder();
      if (path === `/payments:refunds/${REFUND_ID}`) return records.refund ?? null;
      if (path === "/orders") {
        if (query?.where?.paid) return { results: pages.shift() ?? [] };
        return { results: "orders" in records ? records.orders : [makeOrder()] };
      }
      return null;
    }),
    put: vi.fn().mockResolvedValue({}),
    settings: vi.fn().mockResolvedValue({ moneybird: settings }),
  };
}

// the app values written to a path, merged in order
export function putsTo(swell: { put: { mock: { calls: any[][] } } }, path: string) {
  return swell.put.mock.calls.filter(([p]) => p === path).map(([, body]) => body.$app.moneybird);
}
export function savedOn(swell: { put: { mock: { calls: any[][] } } }, path: string) {
  return Object.assign({}, ...putsTo(swell, path));
}
