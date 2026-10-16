import { APP_ID, MoneybirdError, getSettings, missingSettings, salesTaxRates, connectionError } from './lib/moneybird';
import { ORDER_EXPAND, logResult, syncOrder } from './lib/invoices';

export const config: SwellConfig = {
  description: 'Send selected orders to Moneybird',
  action: true,
};

// most orders one run sends; each takes several Moneybird calls and Moneybird allows 150 calls in 5 minutes
export const MAX_SELECTION = 10;
const RECORD_ID = /^[0-9a-f]{24}$/i;

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

// Order action and bulk action: create the invoice of orders that aren't in Moneybird yet, or finish
// the ones that stopped halfway (not numbered, payment not registered)
export default async function (req: SwellRequest) {
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

  const options = { appId: req.appId || APP_ID, adminUrl: req.store?.admin_url, taxRates };
  const sent: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const order of orders) {
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

  const message = summary(sent, skipped, failed, orders.length);
  if (!sent.length) {
    fail(message);
  }
  return { message };
}

function stopsAll(err: unknown): boolean {
  return err instanceof MoneybirdError && (err.retryable || [401, 402, 403].includes(err.status));
}

const list = (items: string[]) => `${items.slice(0, 5).join(' · ')}${items.length > 5 ? ` and ${items.length - 5} more` : ''}`;

// e.g. "Sent 2 orders to Moneybird: 100546 (created, marked as sent, payment registered) · …. Skipped: 100547: order is not paid."
export function summary(sent: string[], skipped: string[], failed: string[], total: number): string {
  const parts = [
    sent.length ? `Sent ${sent.length} order${sent.length === 1 ? '' : 's'} to Moneybird: ${list(sent)}.` : 'Nothing sent to Moneybird.',
  ];
  if (failed.length) parts.push(`Failed: ${list(failed)}`);
  if (skipped.length) parts.push(`Skipped: ${list(skipped)}.`);
  const stopped = total - sent.length - failed.length - skipped.length;
  if (stopped > 0) parts.push(`Stopped before ${stopped} more.`);
  return parts.join(' ');
}
