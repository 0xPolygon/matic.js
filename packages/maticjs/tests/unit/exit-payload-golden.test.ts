import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { POSClient } from '../../src/index.ts';
import { cassetteAdapter, loadCassette } from './cassette-adapter.ts';

/**
 * Offline golden for exit-payload construction.
 *
 * Rebuilds each recorded burn's payload through `POSClient` over two cassette
 * adapters (recorded parent and child RPC responses, replayed with no
 * network) and compares it byte for byte with the payload the production
 * proof-generation API returned for that burn. The same fixtures back the
 * live test in `tests/live/exit-payload.live.test.ts`; this one cannot fail
 * on a rate limit, so a failure here is always a change in the encoding.
 *
 * The cassettes are plain data. Re-record them with
 * `node scripts/record-exit-fixture.mjs --cassette`, never to turn this
 * green: the fixtures' `expectedPayloadHex` is the specification.
 */

interface BurnFixture {
  burnTxHash: string;
  eventSignature: string;
  expectedPayloadHex: string;
}

function loadFixture(name: string): BurnFixture {
  const path = join(__dirname, '..', 'fixtures', 'exits', name);
  return JSON.parse(readFileSync(path, 'utf8')) as BurnFixture;
}

const ROWS = [
  ['ERC-20', 'erc20-burn-1.json'],
  ['ERC-721', 'erc721-burn-1.json'],
  ['ERC-1155', 'erc1155-burn-1.json'],
  ['Plasma ERC-20 (native token)', 'plasma-erc20-burn-1.json']
] as const;

describe('exit payload construction: offline golden', { timeout: 60_000 }, () => {
  for (const [label, file] of ROWS) {
    it(`rebuilds the recorded ${label} burn payload byte-for-byte`, async () => {
      const fixture = loadFixture(file);
      const cassette = loadCassette(file);
      expect(cassette).property('burnTxHash').equals(fixture.burnTxHash);

      const pos = await POSClient.init({
        network: 'mainnet',
        parent: cassetteAdapter(cassette.parent),
        child: cassetteAdapter(cassette.child),
        addresses: cassette.addresses
      });
      const payload = await pos.buildExitPayload(fixture.burnTxHash, fixture.eventSignature, false);

      expect(payload.toLowerCase()).equals(fixture.expectedPayloadHex.toLowerCase());
    });
  }
});
