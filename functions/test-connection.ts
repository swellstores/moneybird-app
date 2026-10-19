import { connectionError, fail, getSettings, listAdministrations, moneybirdRequest, runAction, salesTaxRates } from './lib/moneybird';

export const config: SwellConfig = {
  description: 'Check the Moneybird API token and administration',
  action: true,
};

const SHOWN = 6;
const list = (items: string[]) => `${items.slice(0, SHOWN).join('; ')}${items.length > SHOWN ? `; and ${items.length - SHOWN} more` : ''}`;

// Works while the app is turned off, so the settings can be checked before turning it on. Only reads from Moneybird.
export default function (req: SwellRequest) {
  return runAction('Test connection', () => test(req));
}

async function test(req: SwellRequest) {
  const settings = getSettings(await req.swell.settings());
  if (!settings.api_token) {
    fail('Add the API token and save the settings first.');
  }

  let notes: string[];
  try {
    const administrations = await listAdministrations(settings);
    const describe = (a: any) => `${a.name} (ID ${a.id})`;

    if (!settings.administration_id) {
      if (!administrations.length) {
        fail('The API token has no access to any Moneybird administration.');
      }
      return {
        message:
          administrations.length === 1
            ? `Found administration ${describe(administrations[0])}. Enter its ID in Administration ID and save, then test again.`
            : `The API token has access to ${administrations.length} administrations: ${list(administrations.map(describe))}. ` +
              'Enter the ID of the one to use in Administration ID and save, then test again.',
      };
    }

    const administration = administrations.find((a) => String(a.id) === settings.administration_id);
    if (!administration) {
      fail(
        `The API token has no access to administration ${settings.administration_id}. ` +
          (administrations.length ? `It can use: ${list(administrations.map(describe))}.` : ''),
      );
    }

    const [rates, accounts] = await Promise.all([
      salesTaxRates(settings),
      moneybirdRequest(settings, 'GET', '/financial_accounts').catch(() => null),
    ]);
    notes = [`Connected to ${administration.name} (${administration.currency || 'no currency'}).`];
    notes.push(
      rates.length
        ? `Sales tax rates: ${list(rates.map((r) => `${r.name} ${r.percentage}% = ${r.id}`))}.`
        : 'No active sales tax rates found: invoices use the default tax rate.',
    );
    if (Array.isArray(accounts) && accounts.length) {
      notes.push(`Financial accounts: ${list(accounts.map((a: any) => `${a.name || a.identifier || a.type} = ${a.id}`))}.`);
    }
  } catch (err) {
    if (err instanceof SwellError) {
      throw err;
    }
    fail(connectionError(err));
  }

  if (!settings.enabled) {
    notes.push('The app is turned off, so nothing is sent until you turn it on.');
  }
  return { message: notes.join(' ') };
}
