import {
  APP_ID, MoneybirdError, adminUrlOf, connectionError, getSettings, missingSettings, salesTaxRates, stopReason, type SwellClient,
} from './lib/moneybird';
import { ORDER_EXPAND, syncOrder } from './lib/invoices';

// started by the start-import action, which passes the environment (workflows get no Swell-Env header) and the period
export const config = {
  kind: 'workflow',
  description: 'Send paid orders of the last days to Moneybird',
};

// "test" when start-import ran in the test environment; only trusted from a run a function started
export function runEnv(req: SwellWorkflowRequest): 'test' | null {
  return req.workflow?.trigger === 'function' && (req.data as any)?.env === 'test' ? 'test' : null;
}

// small pages: each order takes several calls and Moneybird allows 150 calls in 5 minutes
export const PAGE_SIZE = 10;
export const DAY_OPTIONS = [7, 30, 90];
const DEFAULT_DAYS = 30;

// a page that hits the rate limit is run again later; finished orders are skipped then
const RETRIES = { retries: { limit: 6, delay: '1 minute', backoff: 'exponential' as const } };

export interface ImportStats {
  sent: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
}

export function emptyStats(): ImportStats {
  return { sent: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
}

export function addStats(a: ImportStats, b: Partial<ImportStats>): ImportStats {
  return {
    sent: a.sent + (b.sent || 0),
    updated: a.updated + (b.updated || 0),
    unchanged: a.unchanged + (b.unchanged || 0),
    skipped: a.skipped + (b.skipped || 0),
    failed: a.failed + (b.failed || 0),
  };
}

export const totalsText = (t: ImportStats) =>
  `sent ${t.sent}, finished ${t.updated}, already in Moneybird ${t.unchanged}, skipped ${t.skipped}, failed ${t.failed}`;

// the modal's period in days; anything else falls back to 30
export function parseDays(value: unknown): number {
  const days = Number(value);
  return DAY_OPTIONS.includes(days) ? days : DEFAULT_DAYS;
}

export async function fetchOrders(swell: Pick<SwellClient, 'get'>, since: string, afterId: string | null): Promise<any[]> {
  const result = await swell.get('/orders', {
    where: {
      date_created: { $gte: since },
      paid: true,
      ...(afterId ? { id: { $gt: afterId } } : {}),
    },
    sort: 'id asc',
    limit: PAGE_SIZE,
    expand: ORDER_EXPAND,
  });
  return result?.results || [];
}

interface PageResult extends ImportStats {
  count: number;
  last_id: string | null;
  // why the run stopped before the page was sent
  stopped?: string;
}

export default class ImportOrders {
  async run(req: SwellWorkflowRequest, step: SwellWorkflowStep) {
    // step output is stored with the run, so keep only flags here, never the API token
    const check = await step.do('load settings', async () => {
      const settings = getSettings(await req.swell.settings());
      const days = parseDays((req.data as any)?.days);
      return {
        enabled: settings.enabled,
        missing: missingSettings(settings),
        days,
        since: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
      };
    });

    // throw so the run ends as failed instead of completed
    if (!check.enabled) {
      throw new Error('Import not started: the Moneybird app is turned off in its settings.');
    }
    if (check.missing.length) {
      throw new Error(`Import not started: add the ${check.missing.join(' and ')} in Apps → Moneybird.`);
    }

    const appId = req.appId || APP_ID;
    // workflows get only the store id, so the dashboard address for order links is built from it
    const env = runEnv(req);
    const adminUrl = adminUrlOf(req.store, env);
    let totals = emptyStats();
    let lastId: string | null = null;

    for (let page = 1; ; page++) {
      const afterId = lastId;
      const result = await step.do(`page ${page}`, RETRIES, async (): Promise<PageResult | { error: string }> => {
        // settings are read in each page so the API token stays out of step output
        const settings = getSettings(await req.swell.settings());
        const empty = { ...emptyStats(), count: 0, last_id: null };
        const stopped = await stopReason(req.swell);
        if (stopped) return { ...empty, stopped };

        const orders = await fetchOrders(req.swell, check.since, afterId);
        const stats = emptyStats();
        try {
          const taxRates = await salesTaxRates(settings);
          // one at a time, to stay within Moneybird's rate limit; finished orders come back as unchanged
          for (const order of orders) {
            // turning the app off stops the run before the next order, not only before the next page
            const reason = await stopReason(req.swell);
            if (reason) return { ...stats, count: 0, last_id: null, stopped: reason };
            const result = await syncOrder(req.swell, settings, order, { appId, adminUrl, env, taxRates });
            if (result.status === 'failed') {
              // a temporary error throws so step.do runs the page again later
              if (result.retry && result.error instanceof MoneybirdError && result.error.retryable) throw result.error;
              // a rejected token or plan limit fails every order: stop the run
              if (result.error instanceof MoneybirdError && [401, 402, 403].includes(result.error.status)) throw result.error;
              console.error(`Moneybird: order ${order.number} not sent - ${result.reason}`);
            }
            stats[result.status]++;
          }
        } catch (err) {
          // step.do retries every thrown error, so a permanent one is returned and fails the run
          if (err instanceof MoneybirdError && !err.retryable) {
            console.error(`Moneybird: import failed: ${err.detail}`);
            return { error: connectionError(err) };
          }
          throw err;
        }
        return { ...stats, count: orders.length, last_id: orders[orders.length - 1]?.id ?? null };
      });

      if ('error' in result) {
        throw new Error(`Import failed on page ${page}. ${result.error} Before failing: ${totalsText(totals)}.`);
      }
      if (result.stopped) {
        throw new Error(`Import stopped: ${result.stopped}. Before stopping: ${totalsText(addStats(totals, result))}.`);
      }

      totals = addStats(totals, result);
      lastId = result.last_id;
      if (result.count < PAGE_SIZE || !lastId) {
        break;
      }
    }

    // a run where Moneybird refused every order it tried shouldn't look successful
    if (totals.failed && !totals.sent && !totals.updated) {
      throw new Error(
        `Import finished, but Moneybird refused all ${totals.failed} orders it was sent; the reasons are on each order's Moneybird tab. Totals: ${totalsText(totals)}.`,
      );
    }
    console.log(`Moneybird: import of the last ${check.days} days finished: ${totalsText(totals)}`);
    return totals;
  }
}
