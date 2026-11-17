/**
 * Unit tests for the ABI diff script.
 *
 * The script is the reviewer's only view of what a `@polygonlabs/meta`
 * bump does to the callable surface, so each rule that decides "added",
 * "removed", "changed" or "format only" gets a fixture item that flips the
 * result if the rule is broken.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

// The script is plain ESM JavaScript with no declaration file, so the shapes
// the tests rely on are stated here and checked at the import boundary.
interface Item {
  kind: string;
  signature: string;
  selector: string | null;
}
interface ContractDiff {
  added: Item[];
  removed: Item[];
  changed: Item[];
  formatOnly: number;
}
interface Diff {
  contracts: Record<string, ContractDiff>;
  onlyBefore: string[];
  onlyAfter: string[];
}
interface Flagged extends Item {
  contract: string;
  change: string;
  files: string[];
}
interface Overlap {
  signature: string;
  selector: string;
}
interface AbiDiffModule {
  describeItem: (item: object) => Item;
  diffAbis: (params: { beforeDir: string; afterDir: string }) => Promise<Diff>;
  collectUsedNames: (params: { srcDir: string; excludeDirs: string[] }) => Set<string>;
  flagUsed: (params: { diff: Diff; used: Set<string> }) => Flagged[];
  findHandCarriedOverlap: (params: {
    generatedDir: string;
    handFile: string;
  }) => Promise<Overlap[]>;
  renderMarkdown: (
    result: { diff: Diff; flagged: Flagged[]; overlap: Overlap[] },
    params: { from: string; to: string; changesetLevel?: 'minor' | 'patch' | 'empty' }
  ) => string;
}

const scriptUrl = new URL('../../scripts/abi-diff.mjs', import.meta.url).href;
const {
  collectUsedNames,
  describeItem,
  diffAbis,
  findHandCarriedOverlap,
  flagUsed,
  renderMarkdown
}: AbiDiffModule = await import(scriptUrl);

const fixtures = fileURLToPath(new URL('../fixtures/abi-diff/', import.meta.url));
const beforeDir = join(fixtures, 'before');
const afterDir = join(fixtures, 'after');
const srcDir = join(fixtures, 'src');
const realAbiDir = fileURLToPath(new URL('../../src/abi/', import.meta.url));

const GONE_TOPIC = '0x4c3cfc0ee5e9c83401c795a837391f599fcd18e8c647b1d179cdfc8166d9d69f';

const sample = async () => {
  const diff = await diffAbis({ beforeDir, afterDir });
  const contract = diff.contracts.Sample;
  if (!contract) throw new Error('fixture contract Sample was not loaded');
  return { diff, contract };
};

const signatures = (items: { signature: string }[]) => items.map((i) => i.signature);

describe('selectors', () => {
  it('hashes a function signature to its 4-byte selector', () => {
    const { selector } = describeItem({
      type: 'function',
      name: 'transfer',
      inputs: [
        { name: 'to', type: 'address' },
        { name: 'amount', type: 'uint256' }
      ],
      outputs: [{ name: '', type: 'bool' }],
      stateMutability: 'nonpayable'
    });
    expect(selector).to.equal('0xa9059cbb');
  });

  it('hashes an event signature to its full 32-byte topic', () => {
    const { selector } = describeItem({
      type: 'event',
      name: 'Transfer',
      inputs: [
        { name: 'from', type: 'address', indexed: true },
        { name: 'to', type: 'address', indexed: true },
        { name: 'value', type: 'uint256', indexed: false }
      ],
      anonymous: false
    });
    expect(selector).to.equal('0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef');
  });

  it('expands tuple arrays in the canonical signature', () => {
    const { signature } = describeItem({
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
      outputs: []
    });
    expect(signature).to.equal('batch((address,uint256)[])');
  });
});

describe('diffAbis', () => {
  it('reports the added function', async () => {
    const { contract } = await sample();
    expect(signatures(contract.added)).to.deep.equal(['addedFn(address)']);
  });

  it('reports removed items, keeping the overload that survives', async () => {
    const { contract } = await sample();
    expect(contract.removed).to.deep.equal([
      { kind: 'event', signature: 'Gone(uint256)', selector: GONE_TOPIC },
      { kind: 'function', signature: 'over(address)', selector: '0xcf19bddf' },
      { kind: 'function', signature: 'removedFn(uint256)', selector: '0xd7b021fe' }
    ]);
  });

  it('reports output, mutability and indexed-flag changes as changed', async () => {
    const { contract } = await sample();
    expect(signatures(contract.changed)).to.deep.equal([
      'Moved(address,address)',
      'mutabilityChanged()',
      'outputChanged()'
    ]);
  });

  it('counts reformatted but semantically equal items as format only', async () => {
    const { contract } = await sample();
    // legacyForm (legacy keys, renamed parameter) and batch (renamed tuple fields).
    expect(contract.formatOnly).to.equal(2);
    expect(signatures(contract.changed)).to.not.include('legacyForm(address)');
  });

  it('reports no contracts on one side only for matching directories', async () => {
    const { diff } = await sample();
    expect(diff.onlyBefore).to.deep.equal([]);
    expect(diff.onlyAfter).to.deep.equal([]);
  });

  it('finds the 14 vendored contracts and no difference against itself', async () => {
    const diff = await diffAbis({ beforeDir: realAbiDir, afterDir: realAbiDir });
    const results = Object.values(diff.contracts);
    expect(results).to.have.lengthOf(14);
    for (const r of results) {
      expect(r.added).to.deep.equal([]);
      expect(r.removed).to.deep.equal([]);
      expect(r.changed).to.deep.equal([]);
      expect(r.formatOnly).to.equal(0);
    }
  });
});

describe('used names', () => {
  it('collects string literals and 32-byte hex literals, not apostrophes in comments', () => {
    const used = collectUsedNames({ srcDir, excludeDirs: [] });
    expect(used.has('removedFn')).to.equal(true);
    expect(used.has(GONE_TOPIC)).to.equal(true);
    expect(used.has('fine')).to.equal(true);
    expect(used.has('addedFn')).to.equal(false);
  });

  it('skips excluded directories', () => {
    expect(collectUsedNames({ srcDir, excludeDirs: [srcDir] }).size).to.equal(0);
  });

  it('flags removed items the source names, and nothing else', async () => {
    const { diff } = await sample();
    const used = collectUsedNames({ srcDir, excludeDirs: [] });
    expect(flagUsed({ diff, used }).map((f) => f.signature)).to.deep.equal([
      'Gone(uint256)',
      'removedFn(uint256)'
    ]);
  });

  it('flags nothing when the source names nothing', async () => {
    const { diff } = await sample();
    expect(flagUsed({ diff, used: new Set() })).to.deep.equal([]);
  });
});

describe('findHandCarriedOverlap', () => {
  // The scratch dir sits inside the package because vitest's module loader
  // cannot import a `.ts` file from outside the project root.
  const dir = mkdtempSync(join(fixtures, 'hand-'));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns selectors present in both the generated ABI and the hand file', async () => {
    const handFile = join(dir, 'hand.ts');
    writeFileSync(
      handFile,
      `export const HandABI = [
  { type: 'function', name: 'stable', inputs: [{ name: 'a', type: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'onlyHere', inputs: [], outputs: [], stateMutability: 'view' }
] as const;\n`
    );
    const overlap = await findHandCarriedOverlap({ generatedDir: afterDir, handFile });
    expect(overlap.map((o) => o.signature)).to.deep.equal(['stable(uint256)']);
  });
});

describe('renderMarkdown', () => {
  const render = async (used: Set<string>, changesetLevel?: 'minor' | 'patch' | 'empty') => {
    const { diff } = await sample();
    const result = { diff, flagged: flagUsed({ diff, used }), overlap: [] };
    return renderMarkdown(result, { from: '1.1.1', to: '1.2.0', changesetLevel });
  };

  it('states the changeset level it is given, and none when absent', async () => {
    const section = async (level?: 'minor' | 'patch' | 'empty') =>
      (await render(new Set(), level)).split('## Changeset\n')[1]?.split('\n')[0] ?? '';
    expect(await section('minor')).to.match(
      /^`minor` for `@polygonlabs\/maticjs`, because .*lose or change/
    );
    expect(await section('patch')).to.match(
      /^`patch` for `@polygonlabs\/maticjs`, because .*only gain/
    );
    expect(await section('empty')).to.match(/^Empty, because no published file changed/);
    const absent = await section();
    expect(absent).to.not.match(/`minor`|`patch`|Empty/);
    expect(absent).to.include('set by the changeset file');
  });

  it('is byte-stable across calls', async () => {
    const used = collectUsedNames({ srcDir, excludeDirs: [] });
    expect(await render(used)).to.equal(await render(used));
  });

  it('carries the decision banner only when an item is flagged', async () => {
    const flagged = await render(collectUsedNames({ srcDir, excludeDirs: [] }));
    const clean = await render(new Set());
    expect(flagged).to.include('Needs a decision before merge');
    expect(flagged).to.include('2 removed or changed item(s)');
    expect(clean).to.not.include('Needs a decision before merge');
    expect(clean).to.include('None.');
  });

  it('renders the contract table row and the item lists', async () => {
    const md = await render(new Set());
    expect(md).to.include('| Sample | 1 | 3 | 3 | 2 |');
    expect(md).to.include('- `function removedFn(uint256)` `0xd7b021fe`');
    expect(md).to.include('0 other contracts are unchanged.');
  });
});
