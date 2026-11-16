/**
 * Large integers survive the trip SDK → adapter → chain → adapter → SDK
 * without passing through a JS `number`. Each value is written as an
 * allowance and read back through `getAllowance`.
 */
import { describe, expect, it } from 'vitest';

import { buildAdapters } from '../src/adapters.ts';
import { getTestEnv } from '../src/test-env.ts';
import { confirmSuccess, initPos } from './cycle.ts';

const rows = buildAdapters({ suite: 'bigint' });

describe.each(rows)('bigint round-trip via $name', (row) => {
  async function approveAndReadBack(amount: bigint): Promise<bigint> {
    const { tokens } = getTestEnv().E2E_ADDRESSES_JSON;
    const pos = await initPos(row);
    const erc20 = pos.parent.erc20(tokens.root.erc20);
    await confirmSuccess(await erc20.approve(amount));
    return erc20.getAllowance(row.address);
  }

  it('approve(123456789012345678901234567890n) round-trips through getAllowance', async () => {
    const huge = 123_456_789_012_345_678_901_234_567_890n;
    expect(await approveAndReadBack(huge)).equals(huge);
  });

  it('an amount above 2^53 keeps its low bits', async () => {
    // Above 2^53 doubles step by 2, so this odd value cannot survive a
    // trip through a JS number: it would come back off by one.
    const above = (1n << 53n) + 123n;
    expect(await approveAndReadBack(above)).equals(above);
  });
});
