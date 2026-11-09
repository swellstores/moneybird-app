import { APP_ID, adminUrlOf, loadSettings, swellEnv } from './lib/moneybird';
import { INVOICE_EXPAND, forInvoice, logResult, retryIfTemporary, syncOrder } from './lib/invoices';

export const config: SwellConfig = {
  description: 'Send paid subscription invoices to Moneybird as invoices and register their payment',
  model: {
    // fires when a payment on a subscription invoice succeeds (a renewal, or a retried payment)
    events: ['invoice.payment_succeeded'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  if (!data.id) {
    return;
  }

  const settings = await loadSettings(swell);
  if (!settings?.send_invoices) {
    return;
  }

  const invoice = await swell.get(`/invoices/${data.id}`, { expand: INVOICE_EXPAND });
  const env = swellEnv(req);
  const result = await syncOrder(swell, settings, forInvoice(invoice), {
    appId: req.appId || APP_ID,
    adminUrl: adminUrlOf(req.store, env),
    env,
  });
  logResult(`invoice ${invoice?.number ?? data.id}`, result);
  retryIfTemporary(result);
}
