import { describe, expect, it } from 'vitest';

import { withConcurrency } from '../../src/internal/concurrency.js';
import pLimit from '../../src/vendor/p-limit/index.js';

// Pins the behaviour of the concurrency limiter the SDK bundles. The same
// expectations were first run against the published npm package, so any drift
// in the bundled copy (a bad copy, an edited line) fails here.

/** Yields once to the event loop without scheduling a real timer. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Resolves after `ms` milliseconds via setTimeout — ordering tests only. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A promise plus the function that resolves it, for holding a task open. */
const deferred = () => {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const UNSETTLED = Symbol('unsettled');

/** Resolves to UNSETTLED if `promise` has not settled within `ms`. */
const settledWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => 'settled'), sleep(ms).then(() => UNSETTLED)]);

/**
 * Calls the limiter factory with an arbitrary runtime value. The declared
 * parameter type is `number`; going through Reflect.apply lets the test pass
 * the non-number inputs a JavaScript caller could pass, without a type cast.
 */
const createWith = (value: unknown) => {
  Reflect.apply(pLimit, undefined, [value]);
};

describe('bundled p-limit', () => {
  it('rejects a concurrency that is not an integer of 1 or more', () => {
    const message = /^Expected `concurrency` to be a number from 1 and up$/;
    for (const value of [0, -1, 1.5, '2']) {
      expect(() => createWith(value)).throws(TypeError, message);
    }
  });

  it('accepts an infinite concurrency', () => {
    expect(() => pLimit(Number.POSITIVE_INFINITY)).not.throws();
  });

  it('keeps at most `concurrency` tasks in flight and resolves in input order', async () => {
    const limit = pLimit(2);
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        limit(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await tick();
          await tick();
          inFlight--;
          return i;
        })
      )
    );

    expect(maxInFlight).equal(2);
    expect(results).deep.equal([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('starts tasks in FIFO order', async () => {
    const limit = pLimit(1);
    const started: number[] = [];

    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        limit(async () => {
          started.push(i);
          await tick();
        })
      )
    );

    expect(started).deep.equal([0, 1, 2, 3, 4]);
  });

  it('turns a synchronous throw into a rejection and keeps serving later tasks', async () => {
    const limit = pLimit(1);
    const boom = new Error('boom');

    let returned: Promise<never> | undefined;
    expect(() => {
      returned = limit(() => {
        throw boom;
      });
    }).not.throws();
    await expect(returned).rejects.toBe(boom);

    expect(await limit(async () => 'after')).equal('after');
  });

  it('frees the slot of a rejected task', async () => {
    const limit = pLimit(1);
    const boom = new Error('boom');

    const failed = limit(async () => {
      await tick();
      throw boom;
    });
    const next = limit(async () => 'next');

    await expect(failed).rejects.toBe(boom);
    expect(await next).equal('next');
  });

  it('reports activeCount and pendingCount', async () => {
    const limit = pLimit(1);
    expect(limit.activeCount).equal(0);
    expect(limit.pendingCount).equal(0);

    const gate = deferred();
    const tasks = Array.from({ length: 5 }, () => limit(() => gate.promise));
    await Promise.resolve();

    expect(limit.activeCount).equal(1);
    expect(limit.pendingCount).equal(4);

    gate.release();
    await Promise.all(tasks);

    expect(limit.activeCount).equal(0);
    expect(limit.pendingCount).equal(0);
  });

  it('passes extra arguments through to the task', async () => {
    const limit = pLimit(1);
    expect(await limit((a: number, b: number) => a + b, 1, 2)).equal(3);
  });

  it('clearQueue drops pending tasks and leaves their promises unsettled', async () => {
    const limit = pLimit(1);
    const gate = deferred();
    let ranAfterClear = false;

    const running = limit(() => gate.promise);
    const pendingA = limit(async () => {
      ranAfterClear = true;
    });
    const pendingB = limit(async () => {
      ranAfterClear = true;
    });
    await Promise.resolve();
    expect(limit.pendingCount).equal(2);

    limit.clearQueue();
    expect(limit.pendingCount).equal(0);

    gate.release();
    await running;

    expect(await settledWithin(pendingA, 20)).equal(UNSETTLED);
    expect(await settledWithin(pendingB, 20)).equal(UNSETTLED);
    expect(ranAfterClear).equal(false);
  });
});

// The SDK's wrapper, covered from the same place as the limiter it calls. These
// mirror the expectations in tests/unit/concurrency.test.ts.
describe('withConcurrency over the bundled p-limit', () => {
  it('respects the limit (max N in flight)', async () => {
    const LIMIT = 2;
    const N = 10;
    let inFlight = 0;
    let maxInFlight = 0;

    const items = Array.from({ length: N }, (_, i) => i);

    const results = await withConcurrency(LIMIT, items, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
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
