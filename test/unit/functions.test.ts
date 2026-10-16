import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import {
  ACCOUNT_ID,
  ADMIN,
  ADMIN_URL,
  CONTACT_ID,
  INVOICE_ID,
  ORDER_ID,
  REFUND_ID,
  bodyOf,
  callKeys,
  fail,
  makeOrder,
  makeSwell,
  mockMoneybird,
  ok,
  rawSettings,
  savedOn,
} from "../helpers/moneybird-fixtures";
import orderEvents, { config as orderConfig } from "../../functions/order-events";
import refundEvents, { config as refundConfig } from "../../functions/refund-events";
import accountEvents, { config as accountConfig, isContactChange } from "../../functions/account-events";
import testConnection, { config as testConfig } from "../../functions/test-connection";
import sendToMoneybird, { MAX_SELECTION, config as sendConfig } from "../../functions/send-to-moneybird";
import ImportOrders, { PAGE_SIZE, config as importConfig, parseDays } from "../../functions/import-orders";

let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(data: Record<string, any>, records: Record<string, any> = {}, settings: any = rawSettings) {
  const swell = makeSwell(records, settings);
  const req = createMockRequest({ data, swell: swell as any, store: { admin_url: ADMIN_URL } as any, appId: "moneybird" });
  return { req, swell };
}

const off = { ...rawSettings, enabled: false };
const orderPath = `/orders/${ORDER_ID}`;

// failures are thrown as a 400 so the admin shows them as a red error popup
async function expectFailure(result: Promise<unknown>, message: string | RegExp) {
  const err: any = await result.then(
    () => null,
    (e) => e,
  );
  expect(err).toMatchObject({ name: "SwellError", status: 400 });
  if (typeof message === "string") expect(err.message).toBe(message);
  else expect(err.message).toMatch(message);
}

describe("order-events", () => {
  it("sends paid orders", async () => {
    expect(orderConfig.model?.events).toEqual(["order.paid"]);
    const fetchMock = mockMoneybird();
    const { req, swell } = request({ id: ORDER_ID, $event: { type: "order.paid" } });
    await orderEvents(req);
    expect(swell.get).toHaveBeenCalledWith(orderPath, { expand: ["account", "items.product", "items.variant"] });
    expect(callKeys(fetchMock)).toContain("POST /sales_invoices");
    // the payment is dated when order.paid fires
    expect(bodyOf(fetchMock, `POST /sales_invoices/${INVOICE_ID}/payments`).payment.payment_date).toBe(new Date().toISOString().slice(0, 10));
    expect(logSpy).toHaveBeenCalledWith(`Moneybird: order 100546 - created, marked as sent, payment registered (${INVOICE_ID})`);
  });

  it("does nothing when the app is off or not set up", async () => {
    const fetchMock = mockMoneybird();
    for (const settings of [off, { api_token: "t" }]) {
      const { req, swell } = request({ id: ORDER_ID }, {}, settings);
      await orderEvents(req);
      expect(swell.get).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws temporary failures so Swell runs the event again, and not permanent ones", async () => {
    mockMoneybird({ "POST /sales_invoices": fail(503, "down") });
    await expect(orderEvents(request({ id: ORDER_ID }).req)).rejects.toMatchObject({ status: 503 });

    vi.restoreAllMocks();
    mockMoneybird({ "POST /sales_invoices": fail(422, "reference is invalid") });
    const { req, swell } = request({ id: ORDER_ID });
    await expect(orderEvents(req)).resolves.toBeUndefined();
    expect(savedOn(swell, orderPath).moneybird_error).toBe("Couldn't create the invoice: Moneybird refused it: reference is invalid");
  });
});

describe("refund-events", () => {
  const sentOrder = makeOrder({ $app: { moneybird: { moneybird_invoice_id: INVOICE_ID, moneybird_invoice_type: "sales_invoice" } } });
  const refund = { id: REFUND_ID, order_id: ORDER_ID, amount: 10, number: "100015" };
  const creditRoutes = {
    "POST /sales_invoices": ok({ id: "cr_1", state: "draft", total_price_incl_tax: "-10.0" }, 201),
    "PATCH /sales_invoices/cr_1/send_invoice": ok({ id: "cr_1", state: "open", invoice_id: "2026-0043", total_price_incl_tax: "-10.0" }),
    "POST /sales_invoices/cr_1/payments": ok({ id: "p" }, 201),
  };

  it("sends a refund of an order in Moneybird", async () => {
    expect(refundConfig.model?.events).toEqual(["payment.refund.succeeded"]);
    const fetchMock = mockMoneybird(creditRoutes);
    const { req, swell } = request({ ...refund, $event: { type: "payment.refund.succeeded" } }, { order: sentOrder });
    await refundEvents(req);
    expect(callKeys(fetchMock)).toContain("POST /sales_invoices/cr_1/payments");
    expect(savedOn(swell, orderPath).moneybird_refunds).toEqual({ [REFUND_ID]: "cr_1" });
  });

  it("reads the refund when the event has only its ID", async () => {
    mockMoneybird(creditRoutes);
    const { req, swell } = request({ id: REFUND_ID }, { order: sentOrder, refund });
    await refundEvents(req);
    expect(swell.get).toHaveBeenCalledWith(`/payments:refunds/${REFUND_ID}`);
    expect(savedOn(swell, orderPath).moneybird_refunds).toEqual({ [REFUND_ID]: "cr_1" });
  });

  it("does nothing when refunds are off, the app is off, or the refund has no order", async () => {
    const fetchMock = mockMoneybird();
    for (const settings of [off, { ...rawSettings, send_refunds: false }]) {
      const { req, swell } = request(refund, { order: sentOrder }, settings);
      await refundEvents(req);
      expect(swell.get).not.toHaveBeenCalled();
    }
    await refundEvents(request({ id: REFUND_ID, amount: 5 }, { refund: { id: REFUND_ID, amount: 5 } }).req);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("account-events", () => {
  const event = (changed: Record<string, any>, record: Record<string, any> = {}) => ({
    id: ACCOUNT_ID,
    email: "jane@example.com",
    first_name: "Jane",
    last_name: "Doe",
    ...record,
    $event: { type: "account.updated", data: { id: ACCOUNT_ID, ...changed } },
  });

  it("updates the contact when contact fields change", async () => {
    expect(accountConfig.model?.events).toEqual(["account.updated"]);
    const fetchMock = mockMoneybird();
    await accountEvents(request(event({ email: "new@example.com" }, { email: "new@example.com" })).req);
    expect(callKeys(fetchMock)).toEqual([`GET /contacts/customer_id/${ACCOUNT_ID}`, `PATCH /contacts/${CONTACT_ID}`]);
    expect(bodyOf(fetchMock, `PATCH /contacts/${CONTACT_ID}`)).toEqual({
      contact: { firstname: "Jane", lastname: "Doe", send_invoices_to_email: "new@example.com", delivery_method: "Email" },
    });
  });

  it("updates the rest of the contact when Moneybird refuses the email", async () => {
    const refused = fail(422, { send_invoices_to_email: ["includes a domain which cannot receive emails"] });
    const fetchMock = mockMoneybird({ [`PATCH /contacts/${CONTACT_ID}`]: [refused, ok({ id: CONTACT_ID })] });
    await accountEvents(request(event({ email: "x@test.com" }, { email: "x@test.com" })).req);
    const patches = fetchMock.mock.calls.filter(([, init]: any) => init?.method === "PATCH").map(([, init]: any) => JSON.parse(init.body).contact);
    expect(patches[1]).toEqual({ firstname: "Jane", lastname: "Doe" });
  });

  it("uses the saved contact ID", async () => {
    const fetchMock = mockMoneybird();
    await accountEvents(request(event({ phone: "1" }, { $app: { moneybird: { moneybird_contact_id: CONTACT_ID } } })).req);
    expect(callKeys(fetchMock)).toEqual([`GET /contacts/${CONTACT_ID}`, `PATCH /contacts/${CONTACT_ID}`]);
  });

  it("renames the contact person instead of letting Moneybird add one", async () => {
    const person = (id: string, firstname: string, lastname: string) => ({ id, firstname, lastname });
    const contact = (people: any[]) =>
      ok({ id: CONTACT_ID, company_name: "Acme", firstname: "Jane", lastname: "Doe", contact_people: people });
    const renamed = event({ first_name: "Janet" }, { first_name: "Janet" });

    let fetchMock = mockMoneybird({
      [`GET /contacts/customer_id/${ACCOUNT_ID}`]: contact([person("p1", "Jane", "Doe"), person("p2", "Bob", "Roe")]),
      [`PATCH /contacts/${CONTACT_ID}/contact_people/p1`]: ok({ id: "p1" }),
    });
    await accountEvents(request(renamed).req);
    expect(callKeys(fetchMock)).toEqual([
      `GET /contacts/customer_id/${ACCOUNT_ID}`,
      `PATCH /contacts/${CONTACT_ID}/contact_people/p1`,
      `PATCH /contacts/${CONTACT_ID}`,
    ]);
    expect(bodyOf(fetchMock, `PATCH /contacts/${CONTACT_ID}/contact_people/p1`)).toEqual({ contact_person: { firstname: "Janet", lastname: "Doe" } });

    // same name, a person with the new name already, or no person with the old name: nothing to rename
    for (const [record, people] of [
      [event({ phone: "1" }, { phone: "1" }), [person("p1", "Jane", "Doe")]],
      [renamed, [person("p1", "Jane", "Doe"), person("p2", "Janet", "Doe")]],
      [renamed, [person("p2", "Bob", "Roe")]],
    ] as const) {
      vi.restoreAllMocks();
      fetchMock = mockMoneybird({ [`GET /contacts/customer_id/${ACCOUNT_ID}`]: contact([...people]) });
      await accountEvents(request(record).req);
      expect(callKeys(fetchMock)).toEqual([`GET /contacts/customer_id/${ACCOUNT_ID}`, `PATCH /contacts/${CONTACT_ID}`]);
    }
  });

  it("ignores the app's own writes, other changes, customers without a contact, and turned off sync", async () => {
    expect(isContactChange(event({ $app: { moneybird: {} } }))).toBe(false);
    expect(isContactChange(event({ order_count: 2 }))).toBe(false);
    const fetchMock = mockMoneybird({ [`GET /contacts/customer_id/${ACCOUNT_ID}`]: fail(404, "record not found") });
    await accountEvents(request(event({ email: "x@y.z" })).req);
    expect(callKeys(fetchMock)).toEqual([`GET /contacts/customer_id/${ACCOUNT_ID}`]);
    for (const settings of [off, { ...rawSettings, sync_contacts: false }]) {
      const { req, swell } = request(event({ email: "x@y.z" }), {}, settings);
      await accountEvents(req);
      expect(swell.settings).toHaveBeenCalled();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("test-connection", () => {
  it("is a settings action", () => {
    expect(testConfig).toMatchObject({ action: true });
  });

  it("asks for the API token first", async () => {
    const fetchMock = mockMoneybird();
    await expectFailure(testConnection(request({}, {}, {}).req), "Add the API token and save the settings first.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("finds the administration when it's empty", async () => {
    mockMoneybird();
    expect((await testConnection(request({}, {}, { api_token: "t" }).req)).message).toBe(
      `Found administration Alder BV (ID ${ADMIN}). Enter its ID in Administration ID and save, then test again.`,
    );
    vi.restoreAllMocks();
    mockMoneybird({ "GET /administrations": ok([{ id: "1", name: "A" }, { id: "2", name: "B" }]) });
    expect((await testConnection(request({}, {}, { api_token: "t" }).req)).message).toMatch(/^The API token has access to 2 administrations: A \(ID 1\); B \(ID 2\)\./);
  });

  it("lists tax rates and financial accounts", async () => {
    mockMoneybird();
    expect((await testConnection(request({}).req)).message).toBe(
      "Connected to Alder BV (EUR). Sales tax rates: 21% btw 21% = tr_21; 9% btw 9% = tr_9. Financial accounts: Mollie = fa_1.",
    );
  });

  it("works while the app is off, and says so", async () => {
    mockMoneybird();
    expect((await testConnection(request({}, {}, off).req)).message).toMatch(/The app is turned off, so nothing is sent until you turn it on\.$/);
  });

  it("shows problems as errors", async () => {
    mockMoneybird();
    await expectFailure(testConnection(request({}, {}, { ...rawSettings, administration_id: "999" }).req), /^The API token has no access to administration 999\. It can use: Alder BV/);
    vi.restoreAllMocks();
    mockMoneybird({ "GET /administrations": fail(401, "invalid token") });
    await expectFailure(testConnection(request({}).req), /^Moneybird rejected the API token/);
  });
});

describe("send-to-moneybird", () => {
  const action = (extra: Record<string, any> = {}) => ({
    $action: { id: "send_to_moneybird", collection: "orders", source: "record", record_id: ORDER_ID, ...extra },
  });

  it("sends an order", async () => {
    expect(sendConfig).toMatchObject({ action: true });
    mockMoneybird();
    const { req, swell } = request(action());
    expect(await sendToMoneybird(req)).toEqual({
      message: "Sent 1 order to Moneybird: 100546 (created, marked as sent, payment registered).",
    });
    expect(swell.get).toHaveBeenCalledWith("/orders", { where: { id: ORDER_ID }, limit: MAX_SELECTION + 1, expand: ["account", "items.product", "items.variant"] });
  });

  it("lists skipped orders, and shows an error when nothing was sent", async () => {
    const fetchMock = mockMoneybird();
    await expectFailure(sendToMoneybird(request(action(), { orders: [makeOrder({ paid: false })] }).req), "Nothing sent to Moneybird. Skipped: 100546: order is not paid.");
    expect(callKeys(fetchMock)).toEqual(["GET /tax_rates"]);
  });

  it("stops at a rejected token", async () => {
    mockMoneybird({ "GET /sales_invoices/find_by_reference/Order%20100546": fail(401, "invalid token") });
    const orders = [makeOrder(), makeOrder({ number: "100547" })];
    await expectFailure(sendToMoneybird(request(action({ source: "bulk", selection: { query: {} } }), { orders }).req), /Failed: 100546: Couldn't create the invoice: Moneybird rejected the API token.* Stopped before 1 more\.$/);
  });

  it("sends nothing more once the app is turned off during the action", async () => {
    const fetchMock = mockMoneybird();
    const { req, swell } = request(action({ source: "bulk", selection: { query: {} } }), { orders: [makeOrder(), makeOrder({ number: "100547" })] });
    swell.settings.mockResolvedValueOnce({ moneybird: rawSettings }).mockResolvedValue({ moneybird: off });
    await expectFailure(sendToMoneybird(req), "Nothing sent to Moneybird. Stopped before 2 more: the app was turned off in its settings.");
    expect(callKeys(fetchMock)).toEqual(["GET /tax_rates"]);
  });

  it("refuses when the app is off or not set up, and checks the selection", async () => {
    const fetchMock = mockMoneybird();
    await expectFailure(sendToMoneybird(request(action(), {}, off).req), "The Moneybird app is turned off in its settings.");
    await expectFailure(sendToMoneybird(request(action(), {}, { api_token: "t" }).req), "Add the Administration ID in Apps → Moneybird first.");
    await expectFailure(sendToMoneybird(request({ $action: { collection: "accounts" } }).req), "Run this action from orders.");
    await expectFailure(sendToMoneybird(request(action({ record_id: "x" })).req), "Open an order to run this action.");
    await expectFailure(sendToMoneybird(request(action({ source: "bulk" })).req), "Select the orders to send.");
    await expectFailure(sendToMoneybird(request(action(), { orders: [] }).req), "No orders found.");
    const many = Array.from({ length: MAX_SELECTION + 1 }, () => makeOrder());
    await expectFailure(sendToMoneybird(request(action(), { orders: many }).req), `Select up to ${MAX_SELECTION} orders.`);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("import-orders", () => {
  // runs steps inline; a thrown error is retried by the real workflow engine, here it propagates
  const step = { do: vi.fn(async (_name: string, a: any, b?: any) => (typeof a === "function" ? a() : b())) } as any;
  const run = (records: Record<string, any>, settings: any = rawSettings, data: any = { days: "7" }) => {
    const { req, swell } = request(data, records, settings);
    return { swell, result: new ImportOrders().run(req as any, step) };
  };

  it("is a workflow action with a period", () => {
    expect(importConfig).toMatchObject({ kind: "workflow", action: true });
    expect(parseDays("90")).toBe(90);
    expect(parseDays("5")).toBe(30);
  });

  it("sends paid orders page by page and returns the totals", async () => {
    mockMoneybird();
    const done = makeOrder({ id: "6ad0bd84dfd3c8001209251a", number: "100540", $app: { moneybird: { moneybird_invoice_id: "x", moneybird_state: "paid", moneybird_paid_at: "y" } } });
    const { swell, result } = run({ pages: [[makeOrder(), done]] });
    expect(await result).toEqual({ sent: 1, updated: 0, unchanged: 1, skipped: 0, failed: 0 });
    expect(swell.get.mock.calls[0][1]).toMatchObject({ where: { paid: true }, sort: "id asc", limit: PAGE_SIZE });
    expect(JSON.stringify(step.do.mock.results)).not.toContain("mb_token");
  });

  it("doesn't start when the app is off or not set up", async () => {
    const fetchMock = mockMoneybird();
    await expect(run({}, off).result).rejects.toThrow("Import not started: the Moneybird app is turned off in its settings.");
    await expect(run({}, { api_token: "t" }).result).rejects.toThrow("Import not started: add the Administration ID in Apps → Moneybird.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops before the next order when the app is turned off during the run", async () => {
    const fetchMock = mockMoneybird();
    const second = makeOrder({ id: "6ad0bd84dfd3c8001209251a", number: "100547" });
    const { req, swell } = request({ days: "7" }, { pages: [[makeOrder(), second]] });
    // on for the start, the page and the first order; off before the second order
    swell.settings
      .mockResolvedValueOnce({ moneybird: rawSettings })
      .mockResolvedValueOnce({ moneybird: rawSettings })
      .mockResolvedValueOnce({ moneybird: rawSettings })
      .mockResolvedValueOnce({ moneybird: rawSettings })
      .mockResolvedValue({ moneybird: off });
    await expect(new ImportOrders().run(req as any, step)).rejects.toThrow(
      "Import stopped: the app was turned off in its settings. Before stopping: sent 1, finished 0, already in Moneybird 0, skipped 0, failed 0.",
    );
    expect(callKeys(fetchMock).filter((k) => k === "POST /sales_invoices")).toHaveLength(1);
  });

  it("fails when Moneybird refused every order, and on a rejected token", async () => {
    mockMoneybird({ "POST /sales_invoices": fail(422, "contact is invalid") });
    await expect(run({ pages: [[makeOrder()]] }).result).rejects.toThrow(/^Import finished, but Moneybird refused all 1 orders/);

    vi.restoreAllMocks();
    mockMoneybird({ "GET /tax_rates": fail(401, "invalid token") });
    await expect(run({ pages: [[makeOrder()]] }).result).rejects.toThrow(/^Import failed on page 1\. Moneybird rejected the API token/);
  });
});
