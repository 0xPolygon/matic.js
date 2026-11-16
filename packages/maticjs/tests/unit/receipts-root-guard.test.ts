/**
 * The receipt proof is only valid on-chain if the trie the SDK builds
 * reproduces the block's `receiptsRoot`. `getReceiptProof` therefore
 * compares the two and throws `ReceiptsRootMismatchError` instead of
 * returning a proof that would revert on-chain after the user has paid
 * gas.
 *
 * The fixture is real Polygon PoS mainnet block 7,000,011 (two legacy
 * receipts), trimmed to the fields the receipt encoding reads. Its
 * `receiptsRoot` comes from the chain, so the uncorrupted case is an
 * independent oracle for the encoding; each corrupted case changes one
 * field of the sibling receipt (not the one being proven) and must be
 * rejected.
 */

import type { Input } from '@ethereumjs/rlp';

import { RLP } from '@ethereumjs/rlp';
import { describe, expect, it } from 'vitest';

import type { IBlockWithTransaction, ITransactionReceipt } from '../../src/interfaces/index.ts';
import type { ProofChildClient } from '../../src/utils/proof_util.ts';

import { ReceiptsRootMismatchError } from '../../src/errors.ts';
import { bytesToHex } from '../../src/utils/bytes.ts';
import { Keccak } from '../../src/utils/keccak.ts';
import { ProofUtil } from '../../src/utils/proof_util.ts';

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
}

interface RawReceipt {
  transactionHash: string;
  transactionIndex: string;
  from: string;
  to: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  status: string;
  type: string;
  logsBloom: string;
  logs: RawLog[];
}

const BLOCK_7000011 = {
  number: 7000011,
  hash: '0xa90857dfc0477f548a7bc32f9f877be49f96065746ed52e32981929898087c4b',
  receiptsRoot: '0x6326e179e062a7b1bdb9dff278e609247df80c75762c707d3e5bd5dd7ac14b6e',
  transactions: [
    '0x082e5083477e4e6beb52abcd83f75eb96009c63851ecb490f73b32fe302b57a4',
    '0x4bbc58e1587853d77cb8ae66903899e613f95c539d9dfc6aade19863f5f65ac4'
  ],
  receipts: [
    {
      transactionHash: '0x082e5083477e4e6beb52abcd83f75eb96009c63851ecb490f73b32fe302b57a4',
      transactionIndex: '0x0',
      from: '0xc9d50e0a571add06c7d5f1452dce2f523fb711a1',
      to: '0x4774fed3f2838f504006be53155ca9cbddee9f0c',
      cumulativeGasUsed: '0x129a9',
      gasUsed: '0x129a9',
      status: '0x1',
      type: '0x0',
      logsBloom:
        '0x08000000000000000000000001000000000000001000000000000000000008000000000000200000000000000000000000008000000008000000000000000200001000000008040000000008000000800000000000000000000100000000008000000000000000000000000000000000400000400000000080000010000000880000000000000000000000000000000000002000000000000000000000000040200000020100000000040000000000000000000000000000000000000020004000000002000400000001000000000200000000000000000000102000000001000010000000000000000000000000000000000000000000000000000000100000',
      logs: [
        {
          address: '0x4774fed3f2838f504006be53155ca9cbddee9f0c',
          topics: [
            '0x06b541ddaa720db2b10a4d0cdac39b8d360425fc073085fac19bc82614677987',
            '0x000000000000000000000000c9d50e0a571add06c7d5f1452dce2f523fb711a1',
            '0x000000000000000000000000c9d50e0a571add06c7d5f1452dce2f523fb711a1',
            '0x00000000000000000000000025e2e5d8ecc4fe46a9505079ed29266779dc7d6f'
          ],
          data: '0x00000000000000000000000000000000000000000000000000038d7ea4c68000000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000c9d50e0a571add06c7d5f1452dce2f523fb711a100000000000000000000000049daa6701d765969f47abcc283d8a91b99ea38f70000000000000000000000000000000000000000000000000000000000000000',
          logIndex: '0x0'
        },
        {
          address: '0x4774fed3f2838f504006be53155ca9cbddee9f0c',
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            '0x000000000000000000000000c9d50e0a571add06c7d5f1452dce2f523fb711a1',
            '0x00000000000000000000000025e2e5d8ecc4fe46a9505079ed29266779dc7d6f'
          ],
          data: '0x00000000000000000000000000000000000000000000000000038d7ea4c68000',
          logIndex: '0x1'
        },
        {
          address: '0x25e2e5d8ecc4fe46a9505079ed29266779dc7d6f',
          topics: [
            '0x47f26a9cfbf6979a650c63549d7f750c0815fc1e0d8d214dadfa8b43bf95a8e3',
            '0x2b25ce401fbdc3f8fc84e902e78b71575e511d657fd1c5ed54b86ec041e60e85',
            '0x0434dc6d82a4cdba4f2e6e043c5ad9b3526be6b36011f0c94c60aaad9a03d586'
          ],
          data: '0x00000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000c9d50e0a571add06c7d5f1452dce2f523fb711a1',
          logIndex: '0x2'
        },
        {
          address: '0x0000000000000000000000000000000000001010',
          topics: [
            '0x4dfe1bbbcf077ddc3e01291eea2d5c70c2b422b415d95645b9adcfd678cb1d63',
            '0x0000000000000000000000000000000000000000000000000000000000001010',
            '0x000000000000000000000000c9d50e0a571add06c7d5f1452dce2f523fb711a1',
            '0x0000000000000000000000005973918275c01f50555d44e92c9d9b353cadad54'
          ],
          data: '0x0000000000000000000000000000000000000000000000000000454ded895a000000000000000000000000000000000000000000000000001e9f3db1bb8e400000000000000000000000000000000000000000000000003b9e469fee894cc8520000000000000000000000000000000000000000000000001e9ef863ce04e60000000000000000000000000000000000000000000000003b9e46e53c76d62252',
          logIndex: '0x3'
        }
      ]
    },
    {
      transactionHash: '0x4bbc58e1587853d77cb8ae66903899e613f95c539d9dfc6aade19863f5f65ac4',
      transactionIndex: '0x1',
      from: '0x1f45205416635b91676abc3fc1cf9ca29773b02e',
      to: '0xf556faf23fc2feefa33ee6db2d1ee4c70e534513',
      cumulativeGasUsed: '0x2acac',
      gasUsed: '0x18303',
      status: '0x1',
      type: '0x0',
      logsBloom:
        '0x00000000000000000000000010000000000000001000000000000000000000000000000000000002000000000000000000008000000000000000000400000000000000000000040000000008001000800000000000000000000100000000000000000000000000000000000000000000800000000000000080000010000000000000000000000000000002000000000000000000000000000000000000000000200000400000000000000000000000000000000000000000000000000000004000008042000000400001000000000200000400000000000000100000000000000000000000000000000000000000000000000000000000000000000000108000',
      logs: [
        {
          address: '0xf556faf23fc2feefa33ee6db2d1ee4c70e534513',
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            '0x0000000000000000000000001f45205416635b91676abc3fc1cf9ca29773b02e',
            '0x0000000000000000000000002bdbe753c6edcb8da750413b1855180934db3b69',
            '0x00000000000000000000000000000000000000000000000000000000000017c1'
          ],
          data: '0x',
          logIndex: '0x4'
        },
        {
          address: '0x0000000000000000000000000000000000001010',
          topics: [
            '0x4dfe1bbbcf077ddc3e01291eea2d5c70c2b422b415d95645b9adcfd678cb1d63',
            '0x0000000000000000000000000000000000000000000000000000000000001010',
            '0x0000000000000000000000001f45205416635b91676abc3fc1cf9ca29773b02e',
            '0x0000000000000000000000005973918275c01f50555d44e92c9d9b353cadad54'
          ],
          data: '0x00000000000000000000000000000000000000000000000000005a1bb22e5e000000000000000000000000000000000000000000000000004393ebceac0d960000000000000000000000000000000000000000000000003b9e46e53c76d62252000000000000000000000000000000000000000000000000439391b2f9df380000000000000000000000000000000000000000000000003b9e473f5829048052',
          logIndex: '0x5'
        }
      ]
    }
  ]
};

// keccak256 of rlp(parentNodes) for receipt index 0, captured from the
// SDK before the receipts-root check existed. Pins that the check
// changes nothing about a valid proof.
const EXPECTED_PARENT_NODES_HASH =
  'efb6578762f08eb7d21b8f2de9129e2cb52d1e481b5ea541cb092f44a13a8b5f';

function toReceipt(raw: RawReceipt): ITransactionReceipt {
  const transactionIndex = Number.parseInt(raw.transactionIndex, 16);
  return {
    transactionHash: raw.transactionHash,
    transactionIndex,
    blockHash: BLOCK_7000011.hash,
    blockNumber: BLOCK_7000011.number,
    from: raw.from,
    to: raw.to,
    contractAddress: '',
    cumulativeGasUsed: Number.parseInt(raw.cumulativeGasUsed, 16),
    gasUsed: Number.parseInt(raw.gasUsed, 16),
    status: raw.status === '0x1',
    logsBloom: raw.logsBloom,
    root: '',
    type: raw.type,
    logs: raw.logs.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      logIndex: Number.parseInt(l.logIndex, 16),
      transactionHash: raw.transactionHash,
      transactionIndex,
      blockHash: BLOCK_7000011.hash,
      blockNumber: BLOCK_7000011.number
    }))
  };
}

function toBlock(): IBlockWithTransaction {
  return {
    size: 0,
    difficulty: 0,
    uncles: [],
    number: BLOCK_7000011.number,
    hash: BLOCK_7000011.hash,
    parentHash: '0x',
    nonce: '0x',
    sha3Uncles: '0x',
    logsBloom: '0x',
    transactionsRoot: '0x',
    stateRoot: '0x',
    receiptsRoot: BLOCK_7000011.receiptsRoot,
    miner: '0x',
    extraData: '0x',
    gasLimit: 0,
    gasUsed: 0,
    timestamp: 0,
    transactions: BLOCK_7000011.transactions.map((hash, i) => ({
      transactionHash: hash,
      nonce: 0,
      blockHash: BLOCK_7000011.hash,
      blockNumber: BLOCK_7000011.number,
      transactionIndex: i,
      from: '0x',
      to: null,
      value: '0x0',
      gasPrice: '0x0',
      gas: 0,
      input: '0x'
    }))
  };
}

/** Serves receipts from memory, so the test exercises the SDK's own fetch path. */
function clientFor(receipts: readonly ITransactionReceipt[]): ProofChildClient {
  const byHash = new Map(receipts.map((r) => [r.transactionHash, r]));
  return {
    getTransactionReceipt(hash: string): Promise<ITransactionReceipt> {
      const receipt = byHash.get(hash);
      if (receipt === undefined)
        return Promise.reject(new Error(`unexpected receipt fetch ${hash}`));
      return Promise.resolve(receipt);
    },
    getRootHash(): Promise<string> {
      return Promise.reject(new Error('not used by the receipt proof'));
    },
    encodeParameters(): string {
      throw new Error('not used by the receipt proof');
    }
  };
}

function isRlpInput(value: unknown): value is Input {
  if (value instanceof Uint8Array) return true;
  return Array.isArray(value) && value.every(isRlpInput);
}

function parentNodesHash(parentNodes: unknown): string {
  if (!isRlpInput(parentNodes)) throw new Error('parentNodes is not RLP-encodable');
  return bytesToHex(Keccak.keccak256(RLP.encode(parentNodes)));
}

const pristine = (): ITransactionReceipt[] => BLOCK_7000011.receipts.map(toReceipt);

type Corruption = [label: string, corrupt: (sibling: ITransactionReceipt) => ITransactionReceipt];

const CORRUPTIONS: Corruption[] = [
  ['cumulativeGasUsed off by one', (r) => ({ ...r, cumulativeGasUsed: r.cumulativeGasUsed + 1 })],
  ['status flipped', (r) => ({ ...r, status: !r.status })],
  ['one log removed', (r) => ({ ...r, logs: (r.logs ?? []).slice(1) })]
];

describe('ProofUtil.getReceiptProof receipts-root check (mainnet block 7,000,011)', () => {
  it('builds the same proof as before for the real, uncorrupted receipts', async () => {
    const receipts = pristine();
    const [target] = receipts;
    if (target === undefined) throw new Error('fixture has no receipts');

    const proof = await ProofUtil.getReceiptProof(target, toBlock(), clientFor(receipts));

    expect(bytesToHex(proof.root)).equals(BLOCK_7000011.receiptsRoot.slice(2));
    expect(bytesToHex(proof.path)).equals('80');
    expect(parentNodesHash(proof.parentNodes)).equals(EXPECTED_PARENT_NODES_HASH);
  });

  it.each(CORRUPTIONS)(
    'rejects with RECEIPTS_ROOT_MISMATCH and returns no proof when the sibling receipt has %s',
    async (_label, corrupt) => {
      const [target, sibling] = pristine();
      if (target === undefined || sibling === undefined)
        throw new Error('fixture needs two receipts');
      const corrupted = corrupt(sibling);
      // The corruption must change the bytes that go into the trie.
      expect(bytesToHex(ProofUtil.getReceiptBytes(corrupted))).not.equals(
        bytesToHex(ProofUtil.getReceiptBytes(sibling))
      );
      const receipts = [target, corrupted];

      let proof: unknown;
      let caught: unknown;
      try {
        proof = await ProofUtil.getReceiptProof(target, toBlock(), clientFor(receipts));
      } catch (err) {
        caught = err;
      }

      expect(proof).equals(undefined);
      const found = ReceiptsRootMismatchError.find(caught);
      expect(found).property('name').equals('ReceiptsRootMismatchError');
      if (found === null) return;
      expect(found.type).equals(undefined);
      expect(found.info).property('blockNumber').equals(BLOCK_7000011.number);
      expect(found.info).property('blockHash').equals(BLOCK_7000011.hash);
      expect(found.info).property('expectedReceiptsRoot').equals(BLOCK_7000011.receiptsRoot);
      expect(found.info)
        .property('computedReceiptsRoot')
        .a('string')
        .not.equals(BLOCK_7000011.receiptsRoot);
    }
  );
});
