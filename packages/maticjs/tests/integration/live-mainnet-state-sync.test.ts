import { createPublicClient, http } from 'viem';
import { describe, expect, it } from 'vitest';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { POSClient } from '../../src/pos-client.ts';

/**
 * Read-only check of `getDepositStatus` against real Polygon PoS mainnet
 * state syncs: two fx-tunnel messages to FxChild (which `getDepositStatus`
 * reads like any deposit) whose delivery failed after the Uburu fork, and two
 * PoS deposits whose delivery failed before it. It needs two
 * RPC URLs because public endpoints differ in what they serve (old blocks,
 * log ranges); it only reads a receipt and latest-state `eth_call`s, no wallet,
 * and is skipped when either variable is unset.
 */
const PARENT_RPC = process.env.POS_SDK_TEST_MAINNET_PARENT_RPC;
const CHILD_RPC = process.env.POS_SDK_TEST_MAINNET_CHILD_RPC;
const HAS_RPCS = Boolean(PARENT_RPC) && Boolean(CHILD_RPC);

/** State id 3212419: failed, then replayed, so it stays delivered for good. */
const REPLAYED_DEPOSIT = '0x86995beaf4cef345d98c86f55b71594ebe068b2d78f9a558771230cae59a419d';
/** State id 3212421: failed and, as far as is known, not yet replayed. */
const STUCK_DEPOSIT = '0x2a1a8ea2c291f95d614c9ebcc80d9b080316b8564e8f2503ef8a003224dfdc3d';
const STUCK_STATE_ID = 3212421n;
const STATE_RECEIVER = '0x0000000000000000000000000000000000001001';
const FAILED_HASH_SELECTOR = '0x8c828b8a';
const FAILED_PAYLOAD_SELECTOR = '0x6757e5d9';
/** State id 3192364: failed before Uburu (stored as a payload) and, as far as is known, not yet replayed. */
const LEGACY_STUCK_DEPOSIT = '0x42dd1048474a89faf5bdcfd1ed48e79827625e9046154d62251a77afcec03345';
const LEGACY_STUCK_STATE_ID = 3192364n;
/** State id 3200225: failed before Uburu, then replayed, so it stays delivered for good. */
const LEGACY_REPLAYED_DEPOSIT =
  '0x696341927ed338c7c6dc044248d8b58917cdd2ae781fcf40c36799ee49b1bb55';
const ADDR = '0x0000000000000000000000000000000000000001';

describe.skipIf(!HAS_RPCS)('live mainnet state-sync delivery', { timeout: 60_000 }, () => {
  const build = async (): Promise<POSClient> =>
    POSClient.init({
      network: 'mainnet',
      parent: viemAdapter({ public: createPublicClient({ transport: http(PARENT_RPC) }) }),
      child: viemAdapter({ public: createPublicClient({ transport: http(CHILD_RPC) }) }),
      // `getDepositStatus` touches neither bridge contract; skip the address-index fetch.
      addresses: {
        RootChainManager: ADDR,
        ERC20Predicate: ADDR,
        ERC721Predicate: ADDR,
        ERC1155Predicate: ADDR,
        EtherPredicate: ADDR,
        RootChain: ADDR,
        GasSwapper: ADDR
      }
    });

  it('reads a replayed deposit as delivered', async () => {
    const pos = await build();
    expect(await pos.getDepositStatus(REPLAYED_DEPOSIT)).deep.equal({ deposited: true });
  });

  it('reads the unreplayed failed deposit as delivery-failed and replayable', async () => {
    const pos = await build();
    const status = await pos.getDepositStatus(STUCK_DEPOSIT);
    if (status.deposited) {
      // Distinguish "someone replayed it" from an SDK misread, so rotating
      // the fixture is an explicit decision.
      const stored = await createPublicClient({ transport: http(CHILD_RPC) }).call({
        to: STATE_RECEIVER,
        data: `${FAILED_HASH_SELECTOR}${STUCK_STATE_ID.toString(16).padStart(64, '0')}`
      });
      expect(stored.data, 'SDK said delivered while a failed record exists').equal(
        `0x${'00'.repeat(32)}`
      );
      expect.fail('fixture replayed: rotate the stuck-deposit fixture');
    }
    expect(status).deep.equal({
      deposited: false,
      reason: 'delivery-failed',
      stateId: STUCK_STATE_ID,
      receiver: '0x8397259c983751daf40400790063935a11afa28a',
      record: 'hash',
      replayable: true
    });
  });

  it('reads a pre-Uburu deposit replayed since as delivered', async () => {
    const pos = await build();
    expect(await pos.getDepositStatus(LEGACY_REPLAYED_DEPOSIT)).deep.equal({ deposited: true });
  });

  it('reads the unreplayed pre-Uburu failed deposit as a replayable payload record', async () => {
    const pos = await build();
    const status = await pos.getDepositStatus(LEGACY_STUCK_DEPOSIT);
    if (status.deposited) {
      const stored = await createPublicClient({ transport: http(CHILD_RPC) }).call({
        to: STATE_RECEIVER,
        data: `${FAILED_PAYLOAD_SELECTOR}${LEGACY_STUCK_STATE_ID.toString(16).padStart(64, '0')}`
      });
      // ABI-encoded empty bytes: offset 0x20, length 0.
      expect(stored.data, 'SDK said delivered while a failed record exists').equal(
        `0x${'00'.repeat(31)}20${'00'.repeat(32)}`
      );
      expect.fail('fixture replayed: rotate the pre-Uburu fixture');
    }
    expect(status).deep.equal({
      deposited: false,
      reason: 'delivery-failed',
      stateId: LEGACY_STUCK_STATE_ID,
      receiver: '0xa6fa4fb5f76172d178d61b04b0ecd319c5d1c0aa',
      record: 'payload',
      replayable: true
    });
  });
});
