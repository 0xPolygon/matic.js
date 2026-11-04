/**
 * Numeric and protocol-level constants used throughout the SDK.
 *
 * Why bigint for `MAX_AMOUNT`: the legacy SDK stored this as a hex string and
 * threaded it through `BN.from(...)` at call time. Now that every internal
 * amount API speaks native `bigint` (Stage 2), the constant is computed once
 * and reused — `2^256 - 1`, the unsigned 256-bit ceiling.
 */
export const MAX_AMOUNT = (1n << 256n) - 1n;

/** Solidity `address(0)`. */
export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000';

export const DAI_PERMIT_TYPEHASH =
  '0xea2aa0a1be11a07ed86d755c93467f4f82362b452371d1ba94d1715123511acb';
export const EIP_2612_PERMIT_TYPEHASH =
  '0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9';
export const EIP_2612_DOMAIN_TYPEHASH =
  '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f';
export const UNISWAP_DOMAIN_TYPEHASH =
  '0x8cad95687ba82c2ce50e74f7b754645e5117c3a5bec8151c0726d5857980a866';

/**
 * Bit set in the `globalIndex` field of L1->L2 LxLy bridge claims to mark that
 * the deposit originated on the Ethereum mainnet rollup. The legacy SDK
 * tracked this as `BigInt(2 ** 64)`; recomputed here so consumers reading
 * `_GLOBAL_INDEX_MAINNET_FLAG` see a stable value rather than a magic number.
 */
export const _GLOBAL_INDEX_MAINNET_FLAG = 1n << 64n;

/**
 * Permit kinds supported by the bridge's permit-flow.
 *
 * `as const` map plus a derived literal-string union, instead of `enum` —
 * the package-wide tsconfig sets `erasableSyntaxOnly: true`, which forbids
 * runtime `enum` declarations because they emit a non-erasable IIFE. The
 * shape exposed to consumers is identical (named values + a type), but
 * compiles to a plain object literal.
 */
export const Permit = {
  DAI: 'DAI',
  EIP_2612: 'EIP_2612',
  UNISWAP: 'UNISWAP'
} as const;

export type Permit = (typeof Permit)[keyof typeof Permit];

/**
 * 32-byte topic[0] event signatures used by the bridge's exit-proof
 * detection. Inlined from the legacy `Log_Event_Signature` enum; the
 * sign-extended hex string IS the discriminator the on-chain contract
 * emits, so the values are part of the public protocol surface and must
 * never change.
 *
 * - `Erc20Transfer` and `Erc721Transfer` are deliberately the same bytes:
 *   ERC-20 and ERC-721 share `Transfer(address,address,uint256)` as
 *   their canonical event, and Solidity hashes the canonical signature
 *   into a single 32-byte topic.
 * - `Erc721BatchTransfer` is the matic-network `WithdrawnBatch` event —
 *   indexer code checks this topic to detect ERC-721 batch withdrawals.
 *
 * The union type `LogEventSignature` is used at every call site that
 * accepts an event-sig parameter, so passing an arbitrary hex string
 * without going through this map fails the type check.
 */
export const LogEventSignature = {
  /**
   * `StateSynced(uint256,address,bytes)` — emitted on the PARENT chain by
   * the StateSender during a deposit's state-sync. `isDeposited` reads
   * `topics[1]` (the state id) from this log in the deposit receipt and
   * compares it against the child chain's `StateReceiver.lastStateId()`.
   */
  StateSynced: '0x103fed9db65eac19c4d870f49ab7520fe03b99f1838e5996caf47e9e43308392',
  Erc20Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  /** ERC-20 and ERC-721 share `Transfer(address,address,uint256)` => same topic. */
  Erc721Transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  Erc1155Transfer: '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62',
  Erc721BatchTransfer: '0xf871896b17e9cb7a64941c62c188a4f5c621b86800e3d15452ece01ce56073df',
  Erc1155BatchTransfer: '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb',
  Erc721TransferWithMetadata: '0xf94915c6d1fd521cee85359239227480c7e8776d7caf1fc3bacad5c269b66a14'
} as const;

export type LogEventSignature = (typeof LogEventSignature)[keyof typeof LogEventSignature];
