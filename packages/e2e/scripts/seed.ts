/**
 * Fund every (suite × adapter) test key on the running devnet. Idempotent:
 * a second run against the same devnet makes no sends.
 *
 *     eval "$(pnpm --filter @polygonlabs/maticjs-e2e run --silent up)"
 *     pnpm --filter @polygonlabs/maticjs-e2e run seed
 */
import { seed } from '../src/seed.ts';

const log = (line: string) => process.stderr.write(`[e2e:seed] ${line}\n`);

const started = Date.now();
const { adminSends, keySends } = await seed({ log });
log(`admin sends: ${String(adminSends)}`);
log(`key sends: ${String(keySends)}`);
log(`done in ${String(Math.round((Date.now() - started) / 1000))} s`);
