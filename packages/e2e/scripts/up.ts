/**
 * Check that the devnet is up and ready, then print the env the e2e tests
 * need as `export KEY='value'` lines on stdout. The caller evals them:
 *
 *     env_exports=$(pnpm --filter @polygonlabs/maticjs-e2e run --silent up)
 *     eval "$env_exports"
 *
 * It does not start the devnet. It reads a running kurtosis enclave
 * (cold start) or a restored snapshot (`E2E_SNAPSHOT_ADDRESSES_JSON` set),
 * and waits until the devnet can run every test:
 *
 * - L2 is at block 256 or later. The devnet activates its later hardforks
 *   at L2 block 128; waiting for 256 means every test runs on post-fork
 *   blocks, with margin.
 * - Heimdall has acknowledged at least one checkpoint, so exits can be
 *   proven.
 *
 * It records which devnet it read, and whether `.github/scripts/e2e-setup.sh`
 * booted it (`E2E_DEVNET_CREATED_BY_HARNESS=1`) or it was already running, so
 * `scripts/down.ts`, when asked, removes exactly that one and nothing else. Progress goes to stderr; stdout carries only the
 * export lines.
 */
import { createPublicClient, http } from 'viem';
import { z } from 'zod';

import { readDevnet, writeTeardownRecord } from '../src/kurtosis.ts';
import { pollUntil } from '../src/wait.ts';

const MIN_L2_BLOCK = 256n;
const READY_TIMEOUT_MS = 15 * 60_000;

const log = (line: string) => process.stderr.write(`[e2e:up] ${line}\n`);

const CheckpointCountSchema = z.object({ ack_count: z.coerce.number().int() });

const { devnet, teardown } = readDevnet();
writeTeardownRecord(teardown);

const l1 = createPublicClient({ transport: http(devnet.l1RpcUrl) });
const l2 = createPublicClient({ transport: http(devnet.l2RpcUrl) });

const [l1ChainId, l2ChainId] = await Promise.all([l1.getChainId(), l2.getChainId()]);
if (l1ChainId !== devnet.l1ChainId || l2ChainId !== devnet.l2ChainId) {
  throw new Error(
    `unexpected chain ids: L1 ${String(l1ChainId)} (want ${String(devnet.l1ChainId)}), ` +
      `L2 ${String(l2ChainId)} (want ${String(devnet.l2ChainId)})`
  );
}

let lastLogged = 0;
await pollUntil({
  label: `L2 block >= ${MIN_L2_BLOCK.toString()} and at least one checkpoint acknowledged`,
  pollMs: 2_000,
  timeoutMs: READY_TIMEOUT_MS,
  fn: async () => {
    const block = await l2.getBlockNumber({ cacheTime: 0 });
    const response = await fetch(`${devnet.heimdallRestUrl}/checkpoints/count`).catch(
      () => undefined
    );
    const parsed = CheckpointCountSchema.safeParse(
      response?.ok ? await response.json() : undefined
    );
    const checkpoints = parsed.success ? parsed.data.ack_count : 0;
    if (block >= MIN_L2_BLOCK && checkpoints >= 1) {
      log(`devnet ready: L2 block ${block.toString()}, ${String(checkpoints)} checkpoints`);
      return true;
    }
    if (Date.now() - lastLogged > 30_000) {
      lastLogged = Date.now();
      log(`waiting: L2 block ${block.toString()}, ${String(checkpoints)} checkpoints`);
    }
    return undefined;
  }
});

const env: Record<string, string> = {
  E2E_ADDRESSES_JSON: JSON.stringify({
    addresses: devnet.addresses,
    tokens: devnet.tokens,
    admin: devnet.admin
  }),
  E2E_HEIMDALL_REST_URL: devnet.heimdallRestUrl,
  E2E_L1_CHAIN_ID: String(devnet.l1ChainId),
  E2E_L1_RPC_URL: devnet.l1RpcUrl,
  E2E_L2_CHAIN_ID: String(devnet.l2ChainId),
  E2E_L2_RPC_URL: devnet.l2RpcUrl
};

for (const [key, value] of Object.entries(env)) {
  // Single-quote each value and escape embedded single quotes for the shell.
  process.stdout.write(`export ${key}='${value.replaceAll("'", "'\\''")}'\n`);
}
log(`L1 ${devnet.l1RpcUrl}  L2 ${devnet.l2RpcUrl}  heimdall ${devnet.heimdallRestUrl}`);
log(`exported ${String(Object.keys(env).length)} env vars`);
