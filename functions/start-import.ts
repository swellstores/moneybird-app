import { fail, getSettings, missingSettings, runAction, swellEnv } from './lib/moneybird';

export const config: SwellConfig = {
  description: 'Start sending existing orders in the current environment',
  action: true,
};

// Workflows get no request headers, so this action reads the environment (Swell-Env) and passes it with the modal's
// period: the import's invoices then link to the test or live dashboard and get the environment's references
export default function (req: SwellRequest) {
  return runAction('Send existing orders', () => start(req));
}

async function start(req: SwellRequest) {
  // checked here too, so the merchant sees why right away instead of in a failed run; the workflow checks again
  const settings = getSettings(await req.swell.settings());
  if (!settings.enabled) {
    fail('Import not started: the Moneybird app is turned off in its settings.');
  }
  const missing = missingSettings(settings);
  if (missing.length) {
    fail(`Import not started: add the ${missing.join(' and ')} in Apps → Moneybird.`);
  }

  const env = swellEnv(req);
  let run: { id?: string } | undefined;
  try {
    run = await req.swell.workflows.create('import-orders', { env, days: req.data?.days ?? null });
  } catch (err) {
    fail(`Import not started: ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`Moneybird: started order import ${run?.id}${env ? ' (test environment)' : ''}`);
  return { message: 'Import started. Follow it in the Workflows tab of the app.' };
}
