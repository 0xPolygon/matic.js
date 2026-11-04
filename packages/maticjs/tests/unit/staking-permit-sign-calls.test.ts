import { Wallet as WalletV6 } from 'ethers';
import { Wallet as WalletV5 } from 'ethers-v5';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import type { Hex } from '../../src/adapter.ts';

import { buildPermitTypedData } from '../../src/staking/permit.ts';

/**
 * The migration guide tells consumers to pass `preparePermit`'s output
 * straight to their own wallet's `signTypedData`. These calls are written
 * exactly as documented, so `pnpm run typecheck` fails if
 * `PermitTypedData` stops being assignable to any of the three libraries'
 * parameter types (a `readonly` tuple, for one, is rejected by ethers'
 * mutable `TypedDataField[]`). At runtime they must agree on the
 * signature, or one library is hashing a different digest.
 */

const PRIVATE_KEY: Hex = `0x${'59'.repeat(32)}`;
const typed = buildPermitTypedData({
  domain: {
    name: 'Polygon Ecosystem Token',
    version: '1',
    chainId: 1,
    verifyingContract: '0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6'
  },
  owner: privateKeyToAccount(PRIVATE_KEY).address,
  spender: '0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908',
  value: 10n ** 18n,
  nonce: 0n,
  deadline: 1_800_000_000n
});

describe('permit typed data — documented sign calls', () => {
  it('signs identically with viem, ethers v6 and ethers v5', async () => {
    const account = privateKeyToAccount(PRIVATE_KEY);
    // A local account signs offline; the transport is never called.
    const walletClient = createWalletClient({ account, transport: http('http://127.0.0.1:1') });

    const viemSig = await walletClient.signTypedData({ account, ...typed });
    const v6Sig = await new WalletV6(PRIVATE_KEY).signTypedData(
      typed.domain,
      typed.types,
      typed.message
    );
    const v5Sig = await new WalletV5(PRIVATE_KEY)._signTypedData(
      typed.domain,
      typed.types,
      typed.message
    );

    expect(v6Sig).equal(viemSig);
    expect(v5Sig).equal(viemSig);
  });

  it('returns a fresh types object per call so one consumer cannot alter another permit', () => {
    const a = buildPermitTypedData({ ...typed.message, domain: typed.domain });
    const b = buildPermitTypedData({ ...typed.message, domain: typed.domain });
    expect(a.types).not.equal(b.types);
    expect(a.types.Permit).not.equal(b.types.Permit);
    expect(a.types).deep.equal(b.types);
  });
});
