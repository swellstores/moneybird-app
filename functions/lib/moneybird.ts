export const APP_ID = 'moneybird';

// Moneybird API v2; every administration's resources live under /api/v2/<administration id>
export const API_BASE = 'https://moneybird.com/api/v2';
export const WEB_BASE = 'https://moneybird.com';

// the parts of the Swell client the app uses; functions and workflows both provide them
export interface SwellClient {
  get(path: string, data?: any): Promise<any>;
  put(path: string, data?: any): Promise<any>;
  settings(): Promise<any>;
}

// values stored on a standard record under $app.<app id>
export function appValues(values: Record<string, any>, appId = APP_ID): { $app: Record<string, any> } {
  return { $app: { [appId]: values } };
}

// the app's values on a record
export function appData(record: any, appId = APP_ID): Record<string, any> {
  return record?.$app?.[appId] || {};
}

export type InvoiceType = 'sales_invoice' | 'external_sales_invoice';
// what happens to a new sales invoice: marked as sent without emailing, emailed, or left as a draft
export type Finalize = 'manual' | 'email' | 'draft';

export interface MoneybirdSettings {
  api_token: string;
  administration_id: string;
  enabled: boolean;
  invoice_type: InvoiceType;
  finalize: Finalize;
  workflow_id: string;
  document_style_id: string;
  default_tax_rate_id: string;
  ledger_account_id: string;
  register_payments: boolean;
  payment_without_proof: boolean;
  financial_account_id: string;
  send_refunds: boolean;
  sync_contacts: boolean;
}

// read app settings and apply defaults for values the merchant has not saved yet
export function getSettings(all: any): MoneybirdSettings {
  const raw = all?.moneybird || {};
  const flag = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
  // Moneybird IDs are 18-digit numbers: keep them as strings, never as JS numbers
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '');

  return {
    api_token: text(raw.api_token),
    administration_id: text(raw.administration_id),
    enabled: flag(raw.enabled, true),
    invoice_type: raw.invoice_type === 'external_sales_invoice' ? 'external_sales_invoice' : 'sales_invoice',
    finalize: raw.finalize === 'email' || raw.finalize === 'draft' ? raw.finalize : 'manual',
    workflow_id: text(raw.workflow_id),
    document_style_id: text(raw.document_style_id),
    default_tax_rate_id: text(raw.default_tax_rate_id),
    ledger_account_id: text(raw.ledger_account_id),
    register_payments: flag(raw.register_payments, true),
    payment_without_proof: flag(raw.payment_without_proof, false),
    financial_account_id: text(raw.financial_account_id),
    send_refunds: flag(raw.send_refunds, true),
    sync_contacts: flag(raw.sync_contacts, true),
  };
}

// the settings the app needs before it can call Moneybird
export function missingSettings(settings: MoneybirdSettings): string[] {
  const missing: string[] = [];
  if (!settings.api_token) missing.push('API token');
  if (!settings.administration_id) missing.push('Administration ID');
  return missing;
}

// load settings and check the app can call Moneybird; null when it's turned off or not set up
export async function loadSettings(swell: Pick<SwellClient, 'settings'>): Promise<MoneybirdSettings | null> {
  const settings = getSettings(await swell.settings());
  if (!settings.enabled) {
    return null;
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    console.error(`Moneybird: missing ${missing.join(', ')} in app settings`);
    return null;
  }
  return settings;
}

// read the settings again in a long run; why it must stop, or undefined while the app is on and set up
export async function stopReason(swell: Pick<SwellClient, 'settings'>): Promise<string | undefined> {
  const settings = getSettings(await swell.settings());
  if (!settings.enabled) return 'the app was turned off in its settings';
  if (missingSettings(settings).length) return 'the API token or Administration ID was removed from the settings';
  return undefined;
}

// Error returned by the Moneybird API (or a network failure when status is 0)
export class MoneybirdError extends Error {
  status: number;
  // the call Moneybird refused, e.g. "POST /sales_invoices" (no administration, query or format)
  endpoint: string | undefined;
  // Moneybird's symbolic error, e.g. { administration: 'limit_reached' }
  symbolic: Record<string, any> | undefined;

  constructor(status: number, message: string, endpoint?: string, symbolic?: Record<string, any>) {
    super(`Moneybird ${status}: ${message}`);
    this.name = 'MoneybirdError';
    this.status = status;
    this.endpoint = endpoint;
    this.symbolic = symbolic;
  }

  // message with the refused call, for logs and workflow errors
  get detail(): string {
    return this.endpoint ? `${this.message} (${this.endpoint})` : this.message;
  }

  // network errors, rate limits and server errors are worth retrying
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

// "error": "text" or { field: ["message"] } → one line
export function errorText(body: any, fallback: string): string {
  const error = body?.error ?? body;
  if (typeof error === 'string' && error.trim()) {
    return error.trim();
  }
  if (error && typeof error === 'object') {
    const parts = Object.entries(error).map(([field, value]) => `${field} ${Array.isArray(value) ? value.join(', ') : String(value)}`);
    if (parts.length) return parts.join('; ');
  }
  return fallback;
}

// call Moneybird; `path` is relative to the administration ("/sales_invoices"), or absolute with `root`
export async function moneybirdRequest(
  settings: Pick<MoneybirdSettings, 'api_token' | 'administration_id'>,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: object,
  options: { root?: boolean; query?: Record<string, string> } = {},
): Promise<any> {
  const endpoint = `${method} ${path}`;
  const query = options.query ? `?${new URLSearchParams(options.query)}` : '';
  const url = `${API_BASE}${options.root ? '' : `/${encodeURIComponent(settings.administration_id)}`}${path}.json${query}`;
  const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${settings.api_token}` };
  if (body) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err: any) {
    throw new MoneybirdError(0, err?.message || String(err), endpoint);
  }

  const text = await res.text();
  let json: any = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    throw new MoneybirdError(res.status, errorText(json, text.slice(0, 300) || res.statusText || `HTTP ${res.status}`), endpoint, json?.symbolic);
  }
  return json;
}

// merchant-facing explanation of a failed call
export function connectionError(err: unknown): string {
  if (err instanceof MoneybirdError) {
    if (err.status === 401) {
      return (
        `Moneybird rejected the API token (${err.message}). Create a new one in Moneybird → Settings → ` +
        'External applications and AI connections → New API token, and paste it in the app settings.'
      );
    }
    if (err.status === 403) {
      return `The API token isn't allowed to do this (${err.message}). Give the token access to sales invoices and settings.`;
    }
    if (err.status === 402) {
      return `Your Moneybird plan doesn't allow this (${err.message}). Check your subscription in Moneybird.`;
    }
    if (err.status === 404 && /administration/i.test(err.message)) {
      return `Moneybird didn't find the administration (${err.message}). Check the Administration ID.`;
    }
    if (err.status === 422) {
      return `Moneybird refused it: ${err.message.replace(/^Moneybird 422: /, '')}`;
    }
    if (err.retryable) {
      return `Moneybird is not available right now (${err.message}), try again later.`;
    }
    return `Moneybird request failed: ${err.detail}`;
  }
  return `Moneybird request failed: ${err instanceof Error ? err.message : String(err)}`;
}

// --- administrations, tax rates ---

export async function listAdministrations(settings: Pick<MoneybirdSettings, 'api_token' | 'administration_id'>): Promise<any[]> {
  const list = await moneybirdRequest(settings, 'GET', '/administrations', undefined, { root: true });
  return Array.isArray(list) ? list : [];
}

export interface TaxRate {
  id: string;
  name: string;
  percentage: number;
  country: string | null;
}

// active tax rates for sales invoices
export async function salesTaxRates(settings: MoneybirdSettings): Promise<TaxRate[]> {
  const list = await moneybirdRequest(settings, 'GET', '/tax_rates', undefined, {
    query: { filter: 'tax_rate_type:sales_invoice', per_page: '100' },
  });
  return (Array.isArray(list) ? list : [])
    .filter((rate: any) => rate && rate.active !== false)
    .map((rate: any) => ({
      id: String(rate.id),
      name: String(rate.name ?? ''),
      percentage: Number(rate.percentage),
      country: rate.country || null,
    }))
    .filter((rate) => Number.isFinite(rate.percentage));
}

// the Moneybird tax rate with this percentage: the order country's own rate first, then a general one
export function matchTaxRate(rates: TaxRate[], percentage: number, country?: string): TaxRate | undefined {
  const close = rates.filter((rate) => Math.abs(rate.percentage - percentage) < 0.1);
  const upper = country?.toUpperCase();
  return close.find((rate) => upper && rate.country?.toUpperCase() === upper) || close.find((rate) => !rate.country) || close[0];
}

// --- dates, money, links ---

export const money = (value: unknown) => Math.round((Number(value) || 0) * 100) / 100;

// YYYY-MM-DD
export function day(value?: unknown): string {
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return new Date(Number.isFinite(time) ? time : Date.now()).toISOString().slice(0, 10);
}

export function webUrl(settings: Pick<MoneybirdSettings, 'administration_id'>, kind: 'sales_invoices' | 'external_sales_invoices' | 'contacts', id: string) {
  return `${WEB_BASE}/${settings.administration_id}/${kind}/${id}`;
}
