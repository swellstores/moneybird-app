import { APP_ID, adminUrlOf, loadSettings, swellEnv } from './lib/moneybird';
import { INVOICE_EXPAND, ORDER_EXPAND, forInvoice, logResult, retryIfTemporary, syncRefund } from './lib/invoices';

export const config: SwellConfig = {
  description: 'Send each successful Swell refund to Moneybird as a credit invoice',
  model: {
    // fires once per refund when it succeeds, including partial refunds, of orders and of subscription invoices
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
  const refund = (data.order_id || data.parent_id) && data.amount !== undefined ? data : await swell.get(`/payments:refunds/${data.id}`);
  if (!refund?.id) {
    return;
  }

  const env = swellEnv(req);
  const options = { appId: req.appId || APP_ID, adminUrl: adminUrlOf(req.store, env), env };
  if (refund.order_id) {
    const order = await swell.get(`/orders/${refund.order_id}`, { expand: ORDER_EXPAND });
    if (!order?.id) {
      return;
    }
    const result = await syncRefund(swell, settings, order, refund, options);
    logResult(`refund ${refund.number ?? data.id} of order ${order.number}`, result);
    retryIfTemporary(result);
    return;
  }

  // a refund of a subscription invoice: the refund has no invoice of its own, its payment has
  const invoice = settings.send_invoices ? await refundedInvoice(swell, refund) : null;
  if (!invoice?.id) {
    return;
  }
  const result = await syncRefund(swell, settings, forInvoice(invoice), refund, options);
  logResult(`refund ${refund.number ?? data.id} of invoice ${invoice.number}`, result);
  retryIfTemporary(result);
}

// the subscription invoice the refund's payment was for; null for a refund of a payment without one
async function refundedInvoice(swell: SwellRequest['swell'], refund: { parent_id?: string; invoice_id?: string }) {
  const invoiceId = refund.invoice_id || (refund.parent_id ? (await swell.get(`/payments/${refund.parent_id}`, { fields: 'invoice_id' }))?.invoice_id : null);
  return invoiceId ? swell.get(`/invoices/${invoiceId}`, { expand: INVOICE_EXPAND }) : null;
}
