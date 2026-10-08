// Compiled, never run, by `npm run typecheck`: an ES-module TypeScript
// application reads the package's declarations by its published name.

import { loadFileSync, loadString, CooperError, Duration, Secret, version } from '@joetjen/cooper';

const config: Record<string, unknown> = loadFileSync('config/app.casc', { env: { PORT: '8080' }, dotenv: false });
const later: Promise<Record<string, unknown>> = loadString('#@version = 1.0\na = 1\n');
const installed: string = version;

if (config.timeout instanceof Duration) console.log(config.timeout);
if (config.password instanceof Secret) console.log(String(config.password));

try {
  loadFileSync('missing.casc');
} catch (err) {
  if (err instanceof CooperError) console.log(err.stage, err.message);
}

// @ts-expect-error -- a file is named by a string
loadFileSync(42);

void [later, installed];
