// GENERATED FROM `@polygonlabs/meta/abi/mainnet/v1/plasma/ERC20PredicateBurnOnly` — DO NOT EDIT.
// Regenerate with `pnpm run codegen`. See scripts/generate-abis.ts.

export const PlasmaERC20PredicateABI = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "_withdrawManager",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "_depositManager",
        "type": "address"
      }
    ],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "constructor"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "CHAINID",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "",
        "type": "uint256"
      }
    ],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [
      {
        "internalType": "bytes",
        "name": "state",
        "type": "bytes"
      }
    ],
    "name": "interpretStateUpdate",
    "outputs": [
      {
        "internalType": "bytes",
        "name": "",
        "type": "bytes"
      }
    ],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": true,
    "inputs": [],
    "name": "networkId",
    "outputs": [
      {
        "internalType": "bytes",
        "name": "",
        "type": "bytes"
      }
    ],
    "payable": false,
    "stateMutability": "view",
    "type": "function"
  },
  {
    "constant": false,
    "inputs": [
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      }
    ],
    "name": "onFinalizeExit",
    "outputs": [],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "constant": false,
    "inputs": [
      {
        "internalType": "bytes",
        "name": "data",
        "type": "bytes"
      }
    ],
    "name": "startExitWithBurntTokens",
    "outputs": [],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "constant": false,
    "inputs": [
      {
        "internalType": "bytes",
        "name": "exit",
        "type": "bytes"
      },
      {
        "internalType": "bytes",
        "name": "inputUtxo",
        "type": "bytes"
      },
      {
        "internalType": "bytes",
        "name": "challengeData",
        "type": "bytes"
      }
    ],
    "name": "verifyDeprecation",
    "outputs": [
      {
        "internalType": "bool",
        "name": "",
        "type": "bool"
      }
    ],
    "payable": false,
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
