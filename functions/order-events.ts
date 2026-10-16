import { APP_ID, day, loadSettings } from './lib/moneybird';
import { ORDER_EXPAND, logResult, retryIfTemporary, syncOrder } from './lib/invoices';

export const config: SwellConfig = {
  description: 'Send paid orders to Moneybird as invoices and register their payment',
  model: {
    events: ['order.paid'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  if (!data.id) {
    return;
  }

  const settings = await loadSettings(swell);
  if (!settings) {
    return;
  }

  const order = await swell.get(`/orders/${data.id}`, { expand: ORDER_EXPAND });
  const result = await syncOrder(swell, settings, order, {
    appId: req.appId || APP_ID,
    adminUrl: req.store?.admin_url,
    // order.paid fires when the payment is made
    paymentDate: day(),
  });
  logResult(`order ${order?.number ?? data.id}`, result);
  retryIfTemporary(result);
}
