import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, decodeAbiParameters, http, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Logger } from '../../src/logger.ts';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';

/**
 * Ground truth for the Plasma fast confirm: the calldata
 * `confirmWithdrawFast` prepares from the production proof-generation API
 * must be byte-identical to what `confirmWithdraw` prepares from local
 * construction, for a REAL mainnet Plasma burn.
 *
 * There is no 3.x fast confirm to compare with, and the local devnet has no
 * proof API, so this is the one place the API path meets reality. Both calls
 * are `prepare*`: nothing is signed or sent, no key exists, and the only
 * traffic is reads from public mainnet RPCs and one GET to the proof API.
 *
 * # Why this runs on every `pnpm test`, creds-free
 *
 * Same reasoning as `exit-payload.live.test.ts`: the path is read-only, so
 * gating it on credentials would only let a broken default stay green. The
 * RPCs are overridable via `POS_SDK_TEST_MAINNET_PARENT_RPC` /
 * `POS_SDK_TEST_MAINNET_CHILD_RPC` for rate-limit-free runners.
 *
 * # What a failure means
 *
 * The fast path falls back to local construction when the API fails, so a
 * green comparison alone could mean the API was never used. The test
 * therefore also fails if the client logged that fallback. Past that, any
 * byte difference is a real bug: the payload is verified on-chain. A `429`
 * from a public endpoint is not (re-run it); a byte mismatch always is. The
 * recorded burn and its payload are in
 * `fixtures/exits/plasma-erc20-burn-1.json`.
 */

interface BurnFixture {
  burnTxHash: string;
  expectedPayloadHex: string;
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'exits', 'plasma-erc20-burn-1.json'), 'utf8')
) as BurnFixture;

const PARENT_RPC =
  process.env['POS_SDK_TEST_MAINNET_PARENT_RPC'] ?? 'https://ethereum-rpc.publicnode.com';
const CHILD_RPC = process.env['POS_SDK_TEST_MAINNET_CHILD_RPC'] ?? 'https://polygon.drpc.org';
const PROOF_API = 'https://proof-generator.polygon.technology';

describe(
  'plasma fast confirm: ground truth against the proof API (live mainnet reads)',
  { timeout: 180_000 },
  () => {
    it('prepares the same calldata as the local confirm, from the API payload', async () => {
      const warnings: object[] = [];
      const logger: Logger = {
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: (obj) => {
          warnings.push(obj);
        },
        error: () => {}
      };
      const adapters = {
        parent: viemAdapter({ public: createPublicClient({ transport: http(PARENT_RPC) }) }),
        child: viemAdapter({ public: createPublicClient({ transport: http(CHILD_RPC) }) })
      };
      // Two clients: with a proof API configured even the slow confirm asks the
      // API for some of its steps, which would make the comparison API against
      // API. The local one is built without the URL, so every byte of it comes
      // from RPC.
      const withApi = await PlasmaClient.init({
        network: 'mainnet',
        ...adapters,
        proofGenerationApiUrl: PROOF_API,
        logger
      });
      const local = await PlasmaClient.init({ network: 'mainnet', ...adapters });
      const { MaticToken } = await withApi.getAddresses();

      const fast = await withApi.parent
        .erc20(MaticToken)
        .prepareConfirmWithdrawFast(fixture.burnTxHash);
      const slow = await local.parent.erc20(MaticToken).prepareConfirmWithdraw(fixture.burnTxHash);

      expect(warnings, 'the proof API failed and the fast path fell back to local').deep.equals([]);
      expect(fast).deep.equals(slow);
      const [payload] = decodeAbiParameters(
        parseAbiParameters('bytes'),
        `0x${fast.data.slice(10)}`
      );
      expect(payload.toLowerCase()).equals(fixture.expectedPayloadHex.toLowerCase());
    });
  }
);
