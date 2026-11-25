import { APP_ID, adminUrlOf, loadSettings, swellEnv } from './lib/moneybird';
import { ORDER_EXPAND, invoicesUnpaid, logResult, retryIfTemporary, syncOrder } from './lib/invoices';

export const config: SwellConfig = {
  description: 'Send paid orders to Moneybird as invoices and register their payment',
  model: {
    // order.submitted only sends orders paid with a method in "Also invoice unpaid orders paid with these payment methods"
    events: ['order.paid', 'order.submitted'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  if (!data.id) {
    return;
  }

  const settings = await loadSettings(swell);
  const placed = data.$event?.type === 'order.submitted';
  if (!settings || (placed && !settings.unpaid_methods.length)) {
    return;
  }

  const order = await swell.get(`/orders/${data.id}`, { expand: ORDER_EXPAND });
  // a placed order that's already paid is sent by order.paid
  if (placed && (order?.paid || !invoicesUnpaid(settings, order))) {
    return;
  }
  const env = swellEnv(req);
  const result = await syncOrder(swell, settings, order, {
    appId: req.appId || APP_ID,
    adminUrl: adminUrlOf(req.store, env),
    env,
  });
  logResult(`order ${order?.number ?? data.id}`, result);
  retryIfTemporary(result);
}
