import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  MoneybirdError,
  connectionError,
  day,
  errorText,
  getSettings,
  loadSettings,
  matchTaxRate,
  missingSettings,
  moneybirdRequest,
  salesTaxRates,
} from "../../functions/lib/moneybird";
import { ADMIN, calls, fail, makeSettings, mockMoneybird, ok, rawSettings } from "../helpers/moneybird-fixtures";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings", () => {
  it("applies the defaults of the settings file", () => {
    expect(getSettings({})).toEqual({
      api_token: "",
      administration_id: "",
      enabled: true,
      invoice_type: "sales_invoice",
      finalize: "manual",
      workflow_id: "",
      document_style_id: "",
      default_tax_rate_id: "",
      ledger_account_id: "",
      register_payments: true,
      payment_without_proof: false,
      financial_account_id: "",
      send_refunds: true,
      sync_contacts: true,
    });
  });

  it("keeps saved choices and IDs as strings", () => {
    const settings = getSettings({
      moneybird: { administration_id: " 123 ", invoice_type: "external_sales_invoice", finalize: "email", enabled: false },
    });
    expect(settings).toMatchObject({ administration_id: "123", invoice_type: "external_sales_invoice", finalize: "email", enabled: false });
    expect(getSettings({ moneybird: { finalize: "other" } }).finalize).toBe("manual");
  });

  it("names the missing settings", () => {
    expect(missingSettings(getSettings({}))).toEqual(["API token", "Administration ID"]);
    expect(missingSettings(makeSettings())).toEqual([]);
  });

  it("loads settings only when the app is on and set up", async () => {
    const swell = (raw: any) => ({ settings: vi.fn().mockResolvedValue({ moneybird: raw }) });
    expect(await loadSettings(swell(rawSettings))).toMatchObject({ administration_id: ADMIN });
    expect(await loadSettings(swell({ ...rawSettings, enabled: false }))).toBeNull();
    expect(await loadSettings(swell({ api_token: "t" }))).toBeNull();
  });
});

describe("moneybirdRequest", () => {
  it("calls the administration's endpoint with the token", async () => {
    const fetchMock = mockMoneybird();
    await moneybirdRequest(makeSettings(), "POST", "/contacts", { contact: { firstname: "Jane" } });
    const [call] = calls(fetchMock);
    expect(call.url).toBe(`https://moneybird.com/api/v2/${ADMIN}/contacts.json`);
    expect(call.headers).toMatchObject({ Authorization: "Bearer mb_token", "Content-Type": "application/json" });
    expect(call.body).toEqual({ contact: { firstname: "Jane" } });
  });

  it("lists administrations without one in the path, and adds the query", async () => {
    const fetchMock = mockMoneybird();
    await moneybirdRequest(makeSettings(), "GET", "/administrations", undefined, { root: true });
    await salesTaxRates(makeSettings());
    expect(calls(fetchMock).map((c) => c.url)).toEqual([
      "https://moneybird.com/api/v2/administrations.json",
      `https://moneybird.com/api/v2/${ADMIN}/tax_rates.json?filter=tax_rate_type%3Asales_invoice&per_page=100`,
    ]);
  });

  it("turns errors into MoneybirdError with the endpoint", async () => {
    mockMoneybird({ "POST /sales_invoices": fail(422, { contact_id: ["is invalid"], details: ["can't be blank"] }) });
    const err = await moneybirdRequest(makeSettings(), "POST", "/sales_invoices", {}).catch((e) => e);
    expect(err).toBeInstanceOf(MoneybirdError);
    expect(err.detail).toBe("Moneybird 422: contact_id is invalid; details can't be blank (POST /sales_invoices)");
    expect(err.retryable).toBe(false);
  });

  it("marks network errors, 429 and 5xx as retryable", async () => {
    for (const reply of [new TypeError("fetch failed"), { status: 429, body: "Retry later" }, fail(503, "down")]) {
      vi.restoreAllMocks();
      mockMoneybird({ "GET /tax_rates": reply as any });
      const err = await salesTaxRates(makeSettings()).catch((e) => e);
      expect(err.retryable).toBe(true);
    }
  });
});

describe("errors", () => {
  it("reads both error shapes", () => {
    expect(errorText({ error: "creating sales invoices is limited", symbolic: {} }, "x")).toBe("creating sales invoices is limited");
    expect(errorText({ error: { reference: ["is taken"] } }, "x")).toBe("reference is taken");
    expect(errorText(null, "fallback")).toBe("fallback");
  });

  it("explains each kind of failure", () => {
    expect(connectionError(new MoneybirdError(401, "invalid token"))).toMatch(/^Moneybird rejected the API token \(Moneybird 401: invalid token\)\. Create a new one/);
    expect(connectionError(new MoneybirdError(403, "scope"))).toMatch(/^The API token isn't allowed to do this/);
    expect(connectionError(new MoneybirdError(402, "limited"))).toMatch(/^Your Moneybird plan doesn't allow this/);
    expect(connectionError(new MoneybirdError(422, "reference is taken", "POST /sales_invoices"))).toBe("Moneybird refused it: reference is taken");
    expect(connectionError(new MoneybirdError(429, "Retry later"))).toBe("Moneybird is not available right now (Moneybird 429: Retry later), try again later.");
    expect(connectionError(new MoneybirdError(404, "not found", "GET /sales_invoices/1"))).toBe(
      "Moneybird request failed: Moneybird 404: not found (GET /sales_invoices/1)",
    );
  });
});

describe("tax rates", () => {
  it("keeps active sales rates with numeric percentages", async () => {
    mockMoneybird();
    expect(await salesTaxRates(makeSettings())).toEqual([
      { id: "tr_21", name: "21% btw", percentage: 21, country: null },
      { id: "tr_9", name: "9% btw", percentage: 9, country: null },
    ]);
  });

  it("matches the percentage, preferring the country's own rate", () => {
    const rates = [
      { id: "a", name: "21%", percentage: 21, country: null },
      { id: "b", name: "OSS BE 21%", percentage: 21, country: "BE" },
      { id: "c", name: "0%", percentage: 0, country: null },
    ];
    expect(matchTaxRate(rates, 21.02)?.id).toBe("a");
    expect(matchTaxRate(rates, 21, "be")?.id).toBe("b");
    expect(matchTaxRate(rates, 0)?.id).toBe("c");
    expect(matchTaxRate(rates, 7)).toBeUndefined();
  });

  it("formats dates as days", () => {
    expect(day("2026-10-15T23:48:23.000Z")).toBe("2026-10-15");
  });
});
