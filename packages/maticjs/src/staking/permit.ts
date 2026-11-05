/**
 * EIP-2612 permit helpers for the staking entry.
 *
 * The SDK builds the typed data but never signs it: the `Adapter`
 * contract has no `signTypedData`, and a consumer that wants the
 * permit path already holds a wallet client that can sign (wagmi's
 * `signTypedData`, viem's `walletClient.signTypedData`, ethers'
 * `signer.signTypedData`). Keeping signing out of the SDK means the
 * permit flow needs no adapter change and works with any wallet.
 *
 * Flow: `pol.preparePermit(...)` → sign with your own client →
 * `splitSignature(sig)` → `validatorShare(addr).delegateWithPermit(...)`.
 */

import type { Hex } from '../adapter.js';

import { InvalidHexStringError } from '../errors.js';

/**
 * The EIP-712 domain of the POL token. Exactly four fields: the
 * deployed token's `eip712Domain()` reports `fields = 0x0f`
 * (name, version, chainId, verifyingContract — no salt, no extensions),
 * and a signer that adds or drops a field produces a different digest
 * that `permit` rejects.
 */
export interface PermitDomain {
  name: string;
  version: string;
  /**
   * A `number`, not a `bigint`: older viem 2.x releases drop a `bigint`
   * chainId from the derived `EIP712Domain` type when `types` omits it,
   * hashing a domain without chainId, so the wallet signs a digest the
   * token rejects. A number hashes identically in viem and ethers v5/v6.
   */
  chainId: number;
  verifyingContract: Hex;
}

export interface PermitMessage {
  owner: Hex;
  spender: Hex;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}

/**
 * Typed data ready to hand to a wallet's `signTypedData`. `types`
 * deliberately omits `EIP712Domain`: viem and ethers derive it from
 * `domain` and ethers rejects a `types` map that includes it.
 *
 * `Permit` is a mutable tuple of literal fields: ethers v5 and v6 type
 * their `types` argument as a mutable `TypedDataField[]`, which a
 * `readonly` tuple cannot be passed to, while viem needs the literal
 * `type` strings to infer the message shape. A mutable literal tuple
 * satisfies both.
 */
export interface PermitTypedData {
  domain: PermitDomain;
  types: {
    Permit: [
      { name: 'owner'; type: 'address' },
      { name: 'spender'; type: 'address' },
      { name: 'value'; type: 'uint256' },
      { name: 'nonce'; type: 'uint256' },
      { name: 'deadline'; type: 'uint256' }
    ];
  };
  primaryType: 'Permit';
  message: PermitMessage;
}

/** The `v`, `r`, `s` triple `buyVoucherWithPermit` takes on-chain. */
export interface PermitSignature {
  v: number;
  r: Hex;
  s: Hex;
}

/**
 * A fresh object per call: the returned typed data is mutable, so a
 * shared constant would let one consumer's edit change every later
 * permit's digest.
 */
function permitTypes(): PermitTypedData['types'] {
  return {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ]
  };
}

/** Assemble EIP-2612 permit typed data from already-resolved inputs. */
export function buildPermitTypedData(params: {
  domain: PermitDomain;
  owner: Hex;
  spender: Hex;
  value: bigint;
  nonce: bigint;
  deadline: bigint;
}): PermitTypedData {
  return {
    domain: params.domain,
    types: permitTypes(),
    primaryType: 'Permit',
    message: {
      owner: params.owner,
      spender: params.spender,
      value: params.value,
      nonce: params.nonce,
      deadline: params.deadline
    }
  };
}

const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

/**
 * Split a 65-byte `r ‖ s ‖ v` signature into the parts the contract
 * takes. Some signers (hardware wallets, a few RPC providers) return
 * `v` as the raw recovery id 0/1; the contract's `ecrecover` expects
 * 27/28, so `v < 27` is lifted by 27 — the same normalisation the 3.x
 * staking plugin applied.
 */
export function splitSignature(sig: Hex): PermitSignature {
  if (!SIGNATURE_PATTERN.test(sig)) {
    throw new InvalidHexStringError(
      'Permit signature must be a 65-byte 0x-prefixed hex string (r ‖ s ‖ v)',
      { info: { length: sig.length } }
    );
  }
  const body = sig.slice(2);
  const r: Hex = `0x${body.slice(0, 64)}`;
  const s: Hex = `0x${body.slice(64, 128)}`;
  const rawV = Number.parseInt(body.slice(128, 130), 16);
  return { v: rawV < 27 ? rawV + 27 : rawV, r, s };
}
