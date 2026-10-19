import {
  APP_ID, MoneybirdError, adminUrlOf, connectionError, fail, getSettings, missingSettings, runAction, salesTaxRates, stopReason, swellEnv,
} from './lib/moneybird';
import { ORDER_EXPAND, logResult, syncOrder } from './lib/invoices';

export const config: SwellConfig = {
  description: 'Send selected orders to Moneybird',
  action: true,
};

// most orders one run sends; each takes several Moneybird calls and Moneybird allows 150 calls in 5 minutes
export const MAX_SELECTION = 10;
// a function has 10 seconds (the most it can have), so no new order is started after this; an order takes a few
// seconds, and the ones not reached are sent by running the action again
export const BUDGET_MS = 6_000;
export const TIME_LIMIT_REASON = 'the time limit for one run was reached; run it again to send the rest';
const RECORD_ID = /^[0-9a-f]{24}$/i;

// Order action and bulk action: create the invoice of orders that aren't in Moneybird yet, or finish
// the ones that stopped halfway (not numbered, payment not registered)
export default function (req: SwellRequest) {
  return runAction('Send to Moneybird', () => send(req));
}

async function send(req: SwellRequest) {
  const started = Date.now();
  const action = req.data.$action;
  if (action?.collection !== 'orders') {
    fail('Run this action from orders.');
  }

  let query: Record<string, any>;
  if (action.source === 'record') {
    if (!RECORD_ID.test(String(action.record_id || ''))) {
      fail('Open an order to run this action.');
    }
    query = { where: { id: action.record_id } };
  } else if (action.source === 'bulk' && action.selection?.query) {
    query = action.selection.query;
  } else {
    fail('Select the orders to send.');
  }

  const settings = getSettings(await req.swell.settings());
  if (!settings.enabled) {
    fail('The Moneybird app is turned off in its settings.');
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    fail(`Add the ${missing.join(' and ')} in Apps → Moneybird first.`);
  }

  const found = await req.swell.get('/orders', { ...query, limit: MAX_SELECTION + 1, expand: ORDER_EXPAND });
  const orders: any[] = found?.results ?? [];
  if (!orders.length) {
    fail('No orders found.');
  }
  if (orders.length > MAX_SELECTION) {
    fail(`Select up to ${MAX_SELECTION} orders.`);
  }

  let taxRates;
  try {
    taxRates = await salesTaxRates(settings);
  } catch (err) {
    fail(connectionError(err));
  }

  const env = swellEnv(req);
  const options = { appId: req.appId || APP_ID, adminUrl: adminUrlOf(req.store, env), env, taxRates };
  const sent: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let stoppedBecause: string | undefined;
  for (const order of orders) {
    if (Date.now() - started > BUDGET_MS) {
      stoppedBecause = TIME_LIMIT_REASON;
      break;
    }
    // the app was turned off while the action ran: send nothing more
    stoppedBecause = await stopReason(req.swell);
    if (stoppedBecause) {
      break;
    }
    const result = await syncOrder(req.swell, settings, order, options);
    logResult(`order ${order.number}`, result);
    if (result.status === 'sent' || result.status === 'updated') {
      sent.push(`${order.number} (${result.done.join(', ')})`);
      continue;
    }
    if (result.status !== 'failed') {
      skipped.push(`${order.number}: ${result.reason}`);
      continue;
    }
    failed.push(`${order.number}: ${result.reason}`);
    // a rejected token or plan limit, or an outage, would fail every other order too
    if (stopsAll(result.error)) {
      break;
    }
  }

  const message = summary(sent, skipped, failed, orders.length, stoppedBecause);
  // any failed order makes it an error, also next to orders that were sent (the message lists both)
  if (!sent.length || failed.length) {
    fail(message);
  }
  return { message };
}

function stopsAll(err: unknown): boolean {
  return err instanceof MoneybirdError && (err.retryable || [401, 402, 403].includes(err.status));
}

const list = (items: string[]) => `${items.slice(0, 5).join(' · ')}${items.length > 5 ? ` and ${items.length - 5} more` : ''}`;

// e.g. "Sent 2 orders to Moneybird: 100546 (created, marked as sent, payment registered) · …. Skipped: 100547: order is not paid."
export function summary(sent: string[], skipped: string[], failed: string[], total: number, stoppedBecause?: string): string {
  const parts = [
    sent.length ? `Sent ${sent.length} order${sent.length === 1 ? '' : 's'} to Moneybird: ${list(sent)}.` : 'Nothing sent to Moneybird.',
  ];
  if (failed.length) parts.push(`Failed: ${list(failed)}`);
  if (skipped.length) parts.push(`Skipped: ${list(skipped)}.`);
  const stopped = total - sent.length - failed.length - skipped.length;
  if (stopped > 0) parts.push(`Stopped before ${stopped} more${stoppedBecause ? `: ${stoppedBecause}` : ''}.`);
  return parts.join(' ');
}
