import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../src/adapter.ts';

import { viemAdapter } from '../../src/adapters/viem.ts';
import { StakingClient } from '../../src/staking/staking-client.ts';

/**
 * `pol.preparePermit` against mainnet POL, read-only.
 *
 * # Why this lives here and not in the devnet tier
 *
 * `preparePermit` reads the EIP-712 domain from the token's ERC-5267
 * `eip712Domain()`. The devnet's POL is a generic ERC20Permit without that
 * function, so the e2e tier cannot exercise this read (it is GATED there and
 * proves the permit itself with a harness-built domain). Mainnet POL
 * implements it, with fields `0x0f` (name, version, chainId,
 * verifyingContract). Building the typed data needs no key and signs nothing,
 * so it runs credential-free on every `pnpm test`, like the staking read
 * ground truth.
 *
 * A failure means the SDK decodes the domain wrongly, or POL's domain
 * changed. Either way, permits built by `preparePermit` would no longer
 * verify, so this should fail loudly.
 *
 * Override the RPC with `POS_SDK_TEST_MAINNET_PARENT_RPC`.
 */

const MAINNET_RPC = process.env['POS_SDK_TEST_MAINNET_PARENT_RPC'] ?? 'https://eth.drpc.org';

// Mainnet staking contracts. `preparePermit` reads only the POL token here,
// because the spender is passed explicitly.
const MAINNET_STAKING = {
  StakeManager: '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908',
  MaticToken: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0',
  PolToken: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6'
} as const satisfies Record<string, Hex>;

// Dummy permit inputs: nothing is signed or sent.
const DUMMY_ACCOUNT: Hex = '0x000000000000000000000000000000000000dEaD';
const DUMMY_VALUE = 1n;
const DUMMY_DEADLINE = 2_000_000_000n;

describe('POL permit domain (mainnet, read-only)', { timeout: 30_000 }, () => {
  it('preparePermit reads the EIP-712 domain from the token', async () => {
    const staking = await StakingClient.init({
      network: 'mainnet',
      parent: viemAdapter({
        public: createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) })
      }),
      addresses: MAINNET_STAKING
    });

    const typed = await staking.pol.preparePermit({
      owner: DUMMY_ACCOUNT,
      spender: DUMMY_ACCOUNT,
      value: DUMMY_VALUE,
      deadline: DUMMY_DEADLINE
    });

    expect(typed.domain).deep.equals({
      name: 'Polygon Ecosystem Token',
      version: '1',
      chainId: 1,
      verifyingContract: MAINNET_STAKING.PolToken
    });
    expect(typed).property('primaryType').equals('Permit');
    expect(typed.message).property('deadline').equals(DUMMY_DEADLINE);
  });
});
