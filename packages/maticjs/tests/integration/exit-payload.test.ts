import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, http } from 'viem';
import { describe, expect, it } from 'vitest';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { POSClient } from '../../src/index.ts';

/**
 * Exit-payload ground-truth test — byte-compares the SDK's LOCAL
 * exit-payload construction (the funds-moving withdrawal path: receipt
 * trie, block proof, RLP encoding, checkpoint lookup) against payloads
 * recorded from the production proof-generation API for REAL mainnet
 * burns of all three token standards.
 *
 * # Why this runs on every `pnpm test`, creds-free
 *
 * The go-live review found this path had zero ground-truth coverage —
 * the fixtures shipped as self-skipping placeholders behind a
 * credentials gate, which is exactly how a broken default path stays
 * green. Rebuilding a payload is READ-ONLY: it needs no keys, only
 * public mainnet RPCs (overridable via `POS_SDK_TEST_MAINNET_PARENT_RPC`
 * / `POS_SDK_TEST_MAINNET_CHILD_RPC` for rate-limit-free CI runners).
 *
 * # What a failure means
 *
 * The fixtures' `expectedPayloadHex` came from the proof-generation API
 * and was verified byte-identical to local construction at recording
 * time. A mismatch therefore means the SDK's encoding pipeline changed
 * behaviour — every byte of the payload is consensus-relevant (the
 * RootChainManager verifies it on-chain), so ANY diff is a real bug,
 * not test brittleness. Checkpoint data is immutable once written;
 * fixtures do not go stale.
 *
 * Re-record (e.g. after an intentional protocol change) with
 * `node scripts/record-exit-fixture.mjs`.
 */

interface BurnFixture {
  network: string;
  burnTxHash: string;
  eventSignature: string;
  blockNumber: number;
  expectedPayloadHex: string;
}

function loadFixture(name: string): BurnFixture {
  const path = join(__dirname, '..', 'fixtures', 'exits', name);
  return JSON.parse(readFileSync(path, 'utf8')) as BurnFixture;
}

const FIXTURES = [
  ['ERC-20', loadFixture('erc20-burn-1.json')],
  ['ERC-721', loadFixture('erc721-burn-1.json')],
  ['ERC-1155', loadFixture('erc1155-burn-1.json')]
] as const;

const PARENT_RPC = process.env['POS_SDK_TEST_MAINNET_PARENT_RPC'] ?? 'https://ethereum-rpc.publicnode.com';
const CHILD_RPC = process.env['POS_SDK_TEST_MAINNET_CHILD_RPC'] ?? 'https://polygon.drpc.org';

describe('exit payload construction — ground truth (live mainnet reads)', { timeout: 180_000 }, () => {
  let pos!: POSClient;

  async function client(): Promise<POSClient> {
    pos ??= await POSClient.init({
      network: 'mainnet',
      parent: viemAdapter({ public: createPublicClient({ transport: http(PARENT_RPC) }) }),
      child: viemAdapter({ public: createPublicClient({ transport: http(CHILD_RPC) }) })
    });
    return pos;
  }

  for (const [standard, fixture] of FIXTURES) {
    it(`locally rebuilds the recorded ${standard} burn payload byte-for-byte`, async () => {
      const payload = await (await client()).buildExitPayload(
        fixture.burnTxHash,
        fixture.eventSignature,
        false
      );
      expect(payload.toLowerCase()).equals(fixture.expectedPayloadHex.toLowerCase());
    });
  }

  it('throws TRANSACTION_NOT_FOUND for a nonexistent burn tx', async () => {
    const err = await (await client())
      .buildExitPayload(`0x${'11'.repeat(32)}`, FIXTURES[0][1].eventSignature, false)
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(err).not.equals(null);
    expect(err).property('code').equals('TRANSACTION_NOT_FOUND');
  });
});
