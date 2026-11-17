// GENERATED FROM `fixture/Sample` — DO NOT EDIT.
// Synthetic input for the ABI diff tests; not a real contract.

export const SampleABI = [
  {
    type: 'function',
    name: 'stable',
    inputs: [{ name: 'a', type: 'uint256', internalType: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'addedFn',
    inputs: [{ name: 'who', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'outputChanged',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'mutabilityChanged',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'legacyForm',
    inputs: [{ name: 'account', type: 'address', internalType: 'address' }],
    outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'over',
    inputs: [{ name: 'a', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'batch',
    inputs: [
      {
        name: 'entries',
        type: 'tuple[]',
        components: [
          { name: 'account', type: 'address' },
          { name: 'value', type: 'uint256' }
        ]
      }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'event',
    name: 'Moved',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true }
    ],
    anonymous: false
  }
] as const;
