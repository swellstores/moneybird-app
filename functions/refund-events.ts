import { APP_ID, loadSettings } from './lib/moneybird';
import { ORDER_EXPAND, logResult, retryIfTemporary, syncRefund } from './lib/invoices';

export const config: SwellConfig = {
  description: 'Send each successful Swell refund to Moneybird as a credit invoice',
  model: {
    // fires once per refund when it succeeds, including partial refunds
    events: ['payment.refund.succeeded'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  if (!data.id) {
    return;
  }

  const settings = await loadSettings(swell);
  if (!settings?.send_refunds) {
    return;
  }

  // the event has the refund record; read it again when the order or amount is missing
  const refund = data.order_id && data.amount !== undefined ? data : await swell.get(`/payments:refunds/${data.id}`);
  // refunds of payments without an order (e.g. subscription invoices) aren't sent
  if (!refund?.order_id) {
    return;
  }

  const order = await swell.get(`/orders/${refund.order_id}`, { expand: ORDER_EXPAND });
  if (!order?.id) {
    return;
  }
  const result = await syncRefund(swell, settings, order, refund, { appId: req.appId || APP_ID, adminUrl: req.store?.admin_url });
  logResult(`refund ${refund.number ?? data.id} of order ${order.number}`, result);
  retryIfTemporary(result);
}
