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
    name: 'removedFn',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'outputChanged',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'mutabilityChanged',
    inputs: [],
    outputs: [],
    stateMutability: 'view'
  },
  {
    constant: true,
    inputs: [{ name: 'who', type: 'address' }],
    name: 'legacyForm',
    outputs: [{ name: '', type: 'uint256' }],
    payable: false,
    type: 'function'
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
    name: 'over',
    inputs: [{ name: 'a', type: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'batch',
    inputs: [
      {
        name: 'xs',
        type: 'tuple[]',
        components: [
          { name: 'who', type: 'address' },
          { name: 'amount', type: 'uint256' }
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
      { name: 'to', type: 'address', indexed: false }
    ],
    anonymous: false
  },
  {
    type: 'event',
    name: 'Gone',
    inputs: [{ name: 'value', type: 'uint256', indexed: false }],
    anonymous: false
  }
] as const;
