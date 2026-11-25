import { APP_ID, loadSettings } from './lib/moneybird';
import { invoicesUnpaid, logResult, retryIfTemporary, syncPayment } from './lib/invoices';

export const config: SwellConfig = {
  description: 'Register payments of orders invoiced unpaid on their Moneybird invoice',
  model: {
    // fires once per payment when it succeeds, including partial payments
    events: ['payment.succeeded'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  if (!data.id) {
    return;
  }

  const settings = await loadSettings(swell);
  if (!settings?.unpaid_methods.length || !settings.register_payments) {
    return;
  }

  // the event has the payment record; read it again when the order or amount is missing
  const payment = data.order_id && data.amount !== undefined ? data : await swell.get(`/payments/${data.id}`);
  if (!payment?.order_id) {
    return;
  }

  const order = await swell.get(`/orders/${payment.order_id}`);
  // only orders invoiced unpaid; the payment that makes the order paid is registered by order.paid
  if (!order?.id || order.paid || !invoicesUnpaid(settings, order)) {
    return;
  }
  const result = await syncPayment(swell, settings, order, payment, { appId: req.appId || APP_ID });
  logResult(`payment ${payment.number ?? data.id} of order ${order.number}`, result);
  retryIfTemporary(result);
}
