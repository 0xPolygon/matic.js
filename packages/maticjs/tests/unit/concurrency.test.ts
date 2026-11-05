import { describe, expect, it } from 'vitest';

import { withConcurrency } from '../../src/internal/concurrency.js';

/** Yields once to the event loop without scheduling a real timer. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Resolves after `ms` milliseconds via setTimeout — ordering test only. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('withConcurrency', () => {
  it('respects the limit (max N in flight)', async () => {
    const LIMIT = 2;
    const N = 10;
    let inFlight = 0;
    let maxInFlight = 0;

    const items = Array.from({ length: N }, (_, i) => i);

    const results = await withConcurrency(LIMIT, items, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield enough times that the scheduler has a real chance to start
      // additional gated calls if the limit were not enforced.
      await tick();
      await tick();
      inFlight--;
      return i;
    });

    expect(maxInFlight).lessThanOrEqual(LIMIT);
    expect(maxInFlight).greaterThan(0);
    expect(results).lengthOf(N);
  });

  it('preserves input order in the output array', async () => {
    // Items finish in reverse order because earlier items sleep longer; the
    // output array must still match input order, not completion order.
    const items = [0, 1, 2, 3, 4];
    const results = await withConcurrency(3, items, async (i) => {
      await sleep((items.length - i) * 5);
      return i * 10;
    });
    expect(results).deep.equal([0, 10, 20, 30, 40]);
  });

  it('rejects on the first failure (does not swallow)', async () => {
    const boom = new Error('boom');
    const items = [0, 1, 2, 3, 4];
    await expect(
      withConcurrency(2, items, async (i) => {
        if (i === 2) throw boom;
        await tick();
        return i;
      })
    ).rejects.toBe(boom);
  });
});
