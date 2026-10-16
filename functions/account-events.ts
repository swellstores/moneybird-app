import { APP_ID, MoneybirdError, appData, connectionError, loadSettings, moneybirdRequest } from './lib/moneybird';
import { contactFields, findContact, isEmailRefused } from './lib/invoices';

export const config: SwellConfig = {
  description: "Update the Moneybird contact when a customer's details change",
  model: {
    events: ['account.updated'],
  },
};

// customer fields that appear on the Moneybird contact
const CONTACT_FIELDS = ['first_name', 'last_name', 'name', 'email', 'phone', 'billing', 'shipping', 'vat_number'];

// the update changed a field the contact shows; the app's own writes ($app) don't count
export function isContactChange(data: any): boolean {
  const changed = data?.$event?.data || {};
  return CONTACT_FIELDS.some((field) => changed[field] !== undefined);
}

// Contacts are created with the customer's first order; this only keeps existing ones up to date
export default async function (req: SwellRequest) {
  const { swell, data } = req;
  if (!data.id || !isContactChange(data)) {
    return;
  }

  const settings = await loadSettings(swell);
  if (!settings?.sync_contacts) {
    return;
  }

  try {
    const contactId = appData(data, req.appId || APP_ID).moneybird_contact_id || (await findContact(settings, data.id))?.id;
    if (!contactId) {
      return;
    }
    const { customer_id, ...fields } = contactFields(data);
    try {
      await moneybirdRequest(settings, 'PATCH', `/contacts/${contactId}`, { contact: fields });
    } catch (err) {
      // Moneybird checks that the email's domain can receive mail; update the rest without it
      if (!isEmailRefused(err)) throw err;
      const { send_invoices_to_email, delivery_method, ...rest } = fields;
      await moneybirdRequest(settings, 'PATCH', `/contacts/${contactId}`, { contact: rest });
      console.log(`Moneybird: Moneybird refused the email of customer ${data.id}; updated the rest of contact ${contactId}`);
      return;
    }
    console.log(`Moneybird: updated contact ${contactId} of customer ${data.id}`);
  } catch (err) {
    console.error(`Moneybird: couldn't update the contact of customer ${data.id} - ${connectionError(err)}`);
    // the update is the same every time, so running it again is safe
    if (err instanceof MoneybirdError && err.retryable) {
      throw err;
    }
  }
}
