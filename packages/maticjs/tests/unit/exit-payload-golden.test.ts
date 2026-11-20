import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, decodeAbiParameters, http, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';

import type { Adapter } from '../../src/adapter.ts';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { POSClient } from '../../src/index.ts';
import { PlasmaClient } from '../../src/plasma/plasma-client.ts';
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

  // The Plasma surface builds the same payload through its own client and
  // hands it to the burn-only predicate as the one `bytes` argument. The real
  // viem adapter encodes the call; recorded responses answer every read.
  it('rebuilds the recorded Plasma burn payload through PlasmaClient.prepareConfirmWithdraw', async () => {
    const file = 'plasma-erc20-burn-1.json';
    const fixture = loadFixture(file);
    const cassette = loadCassette(file);
    const encoder = viemAdapter({
      public: createPublicClient({ transport: http('http://127.0.0.1:1') })
    });
    const replaying = (side: Parameters<typeof cassetteAdapter>[0]): Adapter => {
      const replay = cassetteAdapter(side);
      return { ...replay, prepareWrite: (req) => encoder.prepareWrite(req) };
    };
    // Only RootChain is read on this path, so the recording's own address is
    // used for it; the other Plasma addresses are never touched and any
    // distinct values do.
    const matic = cassette.addresses.MaticToken ?? '0x5555555555555555555555555555555555555555';
    const pol = cassette.addresses.PolToken ?? '0x6666666666666666666666666666666666666666';
    const plasma = await PlasmaClient.init({
      network: 'mainnet',
      parent: replaying(cassette.parent),
      child: replaying(cassette.child),
      addresses: {
        RootChain: cassette.addresses.RootChain,
        DepositManager: '0x1111111111111111111111111111111111111111',
        WithdrawManager: '0x2222222222222222222222222222222222222222',
        PlasmaERC20Predicate: '0x3333333333333333333333333333333333333333',
        ExitNFT: '0x4444444444444444444444444444444444444444',
        MaticToken: matic,
        PolToken: pol
      }
    });

    const prepared = await plasma.parent.erc20(matic).prepareConfirmWithdraw(fixture.burnTxHash);

    const [payload] = decodeAbiParameters(
      parseAbiParameters('bytes'),
      `0x${prepared.data.slice(10)}`
    );
    expect(payload.toLowerCase()).equals(fixture.expectedPayloadHex.toLowerCase());
  });
});
