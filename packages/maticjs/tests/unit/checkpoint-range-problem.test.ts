import { describe, expect, it } from 'vitest';

import { checkpointRangeProblem, MAX_CHECKPOINT_BLOCKS } from '../../src/internal/exit-proof.ts';

const MAX = BigInt(MAX_CHECKPOINT_BLOCKS);

describe('checkpointRangeProblem', () => {
  it.each([
    ['a range holding the block', 1n, 256n, 100],
    ['a single-block range', 100n, 100n, 100],
    ['the burn at the start edge', 100n, 200n, 100],
    ['the burn at the end edge', 100n, 200n, 200],
    ['the largest allowed range', 0n, MAX - 1n, 0]
  ])('returns undefined for %s', (_name, start, end, txBlockNumber) => {
    expect(checkpointRangeProblem({ start, end, txBlockNumber })).equal(undefined);
  });

  it.each([
    ['inverted', 200n, 100n, 150, 'inverted'],
    ['burn below the start', 100n, 200n, 99, 'not-containing'],
    ['burn above the end', 100n, 200n, 201, 'not-containing'],
    ['one block over the size cap', 0n, MAX, 0, 'too-large']
  ])('reports %s', (_name, start, end, txBlockNumber, reason) => {
    expect(checkpointRangeProblem({ start, end, txBlockNumber })).equal(reason);
  });

  describe('precedence when several problems hold', () => {
    it('reports inverted before not-containing', () => {
      // 200..100 is inverted, and block 500 is outside it as well.
      expect(checkpointRangeProblem({ start: 200n, end: 100n, txBlockNumber: 500 })).equal(
        'inverted'
      );
    });

    it('reports not-containing before too-large', () => {
      // The range is over the cap and the burn block lies outside it.
      expect(checkpointRangeProblem({ start: 10n, end: 10n + MAX, txBlockNumber: 5 })).equal(
        'not-containing'
      );
    });
  });
});
