// GENERATED FROM `@polygonlabs/meta/abi/mainnet/v1/plasma/WithdrawManager` — DO NOT EDIT.
// Regenerate with `pnpm run codegen`. See scripts/generate-abis.ts.

export const PlasmaWithdrawManagerABI = [
  {
    "type": "fallback",
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "HALF_EXIT_PERIOD",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ON_FINALIZE_GAS_LIMIT",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "addExitToQueue",
    "inputs": [
      {
        "name": "exitor",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "childToken",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "rootToken",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "exitAmountOrTokenId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "txHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "isRegularExit",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "priority",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "addInput",
    "inputs": [
      {
        "name": "exitId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "age",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "utxoOwner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "challengeExit",
    "inputs": [
      {
        "name": "exitId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "inputId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "challengeData",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "adjudicatorPredicate",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "createExitQueue",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "exitNft",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "contract ExitNFT"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "exitWindow",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "exits",
    "inputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "receiptAmountOrNFTId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "txHash",
        "type": "bytes32",
        "internalType": "bytes32"
      },
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "isRegularExit",
        "type": "bool",
        "internalType": "bool"
      },
      {
        "name": "predicate",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "exitsQueues",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "ownerExits",
    "inputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "processExits",
    "inputs": [
      {
        "name": "_token",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "processExitsBatch",
    "inputs": [
      {
        "name": "_tokens",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "startExitWithDepositedTokens",
    "inputs": [
      {
        "name": "depositId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "amountOrToken",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "updateExitPeriod",
    "inputs": [
      {
        "name": "halfExitPeriod",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "verifyInclusion",
    "inputs": [
      {
        "name": "data",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "offset",
        "type": "uint8",
        "internalType": "uint8"
      },
      {
        "name": "verifyTxInclusion",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "ExitCancelled",
    "inputs": [
      {
        "name": "exitId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ExitPeriodUpdate",
    "inputs": [
      {
        "name": "oldExitPeriod",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "newExitPeriod",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ExitStarted",
    "inputs": [
      {
        "name": "exitor",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "exitId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "isRegularExit",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ExitUpdated",
    "inputs": [
      {
        "name": "exitId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "age",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "signer",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Withdraw",
    "inputs": [
      {
        "name": "exitId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "user",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "token",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  }
] as const;
