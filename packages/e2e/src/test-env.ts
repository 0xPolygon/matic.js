/**
 * Validated devnet environment for the e2e tests.
 *
 * Every key is produced by `scripts/up.ts`, whose `export KEY='value'` lines
 * the caller `eval`s before running vitest (`scripts/run-e2e.sh` does this).
 * There is deliberately no `.env` loading: a stray `.env` could point the
 * suite at a public network and burn a run on wrong-chain reverts.
 *
 * Validation is lazy (`getTestEnv()`), so modules that import this file can
 * load in a context where the devnet env is not set yet.
 */
import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

import { DevnetContractsSchema } from './kurtosis.ts';

const RpcUrlSchema = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' });

const DevnetContractsJsonSchema = z
  .string()
  .transform((raw, ctx) => {
    try {
      return JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'must be a JSON string' });
      return z.NEVER;
    }
  })
  .pipe(DevnetContractsSchema);

function buildTestEnv() {
  return createEnv({
    server: {
      E2E_L1_RPC_URL: RpcUrlSchema,
      E2E_L2_RPC_URL: RpcUrlSchema,
      E2E_HEIMDALL_REST_URL: RpcUrlSchema,
      E2E_L1_CHAIN_ID: z.coerce.number().int().positive(),
      E2E_L2_CHAIN_ID: z.coerce.number().int().positive(),
      E2E_ADDRESSES_JSON: DevnetContractsJsonSchema
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true
  });
}

export type TestEnv = ReturnType<typeof buildTestEnv>;

let env: TestEnv | undefined;

export function getTestEnv(): TestEnv {
  return (env ??= buildTestEnv());
}
