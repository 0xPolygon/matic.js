/**
 * ABI fragment for the child `StateReceiver`'s failed-delivery record.
 *
 * Kept out of the generated `StateReceiver` ABI because the published
 * `@polygonlabs/meta` ABI predates the Uburu fork and does not carry it;
 * a hand edit there would be reverted by codegen. Both records are read
 * because a state id is committed once, into whichever generation of the
 * receiver was live, and storage outlives the code swap: a delivery that
 * failed before the Uburu fork sits in `failedStateSyncs`, one since in
 * `failedStateSyncHashes`. `failedStateSyncs(uint256) returns (bytes)`
 * (selector `0x6757e5d9`) is the PIP-36 getter, published in
 * `StateReceiver.sol` of `0xPolygon/genesis-contracts`; its value is
 * `abi.encode(receiver, data)`. Trust for the hash getter rests on three
 * things: the selector `0x8c828b8a` is the keccak preimage of this exact
 * signature; the fork's block-alloc test in bor's public repository names
 * the `failedStateSyncHashes[stateID]` mapping and its value
 * (`keccak256(abi.encode(receiver, data))`); and that value was matched
 * against real mainnet failed records. Fold this into the generated ABI
 * once `@polygonlabs/meta` publishes it.
 */
export const FailedStateSyncHashesABI = [
  {
    constant: true,
    inputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    name: 'failedStateSyncHashes',
    outputs: [{ internalType: 'bytes32', name: '', type: 'bytes32' }],
    payable: false,
    stateMutability: 'view',
    type: 'function'
  },
  {
    constant: true,
    inputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    name: 'failedStateSyncs',
    outputs: [{ internalType: 'bytes', name: '', type: 'bytes' }],
    payable: false,
    stateMutability: 'view',
    type: 'function'
  }
] as const;

/**
 * ABI fragment for the child `StateReceiver`'s two replay entry points, kept
 * beside the failed-record getters for the same reason: the published
 * `@polygonlabs/meta` ABI predates the Uburu fork. `replayFailedStateSync(uint256)`
 * (selector `0x03112a17`) is published source (PIP-36, `StateReceiver.sol` of
 * `0xPolygon/genesis-contracts`) and replays a record kept as a payload.
 * `replayFailedStateSyncWithData(uint256,address,bytes)` (selector
 * `0x94453fd3`) replays a record kept as a hash: its name is the keccak
 * preimage of that selector, and the function and its calling convention
 * were confirmed by the protocol team, while the post-Uburu contract source
 * remains unpublished. Both are exercised against mainnet in the live
 * state-sync test. Fold this into the generated ABI once `@polygonlabs/meta`
 * publishes it.
 */
export const ReplayFailedStateSyncABI = [
  {
    constant: false,
    inputs: [{ internalType: 'uint256', name: 'stateId', type: 'uint256' }],
    name: 'replayFailedStateSync',
    outputs: [],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    constant: false,
    inputs: [
      { internalType: 'uint256', name: 'stateId', type: 'uint256' },
      { internalType: 'address', name: 'receiver', type: 'address' },
      { internalType: 'bytes', name: 'data', type: 'bytes' }
    ],
    name: 'replayFailedStateSyncWithData',
    outputs: [],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function'
  }
] as const;
