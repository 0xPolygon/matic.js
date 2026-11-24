import { describe, expectTypeOf, it } from 'vitest';

import type { ChildERC20ABI, ChildERC721ABI, StakeManagerABI } from '../../src/abi/index.ts';
import type { Hex, PreparedTx, TxResult } from '../../src/adapter.ts';
import type {
  ReadArgs,
  ReadName,
  ReadResult,
  WriteArgs,
  WriteCall,
  WriteName
} from '../../src/internal/abi-types.ts';
import type { ContractCaller } from '../../src/internal/contract-caller.ts';

/**
 * Compile-time proofs that a caller built over an `as const` ABI accepts only
 * that ABI's function names, argument lists and result types. Checked by
 * `tsc` (test files are in the typecheck project), so an unused
 * `@ts-expect-error` below is itself an error and each negative proof is live.
 *
 * Every proof, positive and negative, is written against the class itself:
 * it has one signature per method, so a call that is wrong for the ABI has
 * nothing looser to fall back on.
 */

type Token = typeof ChildERC20ABI;
type Staking = typeof StakeManagerABI;
type Nft = typeof ChildERC721ABI;

declare const token: ContractCaller<Token>;
declare const staking: ContractCaller<Staking>;
declare const untyped: ContractCaller<readonly unknown[]>;
declare const looseName: string;
declare const user: Hex;

type TupleAbi = readonly [
  {
    readonly type: 'function';
    readonly name: 'takesTuple';
    readonly inputs: readonly [{ readonly type: 'tuple'; readonly name: 'x' }];
    readonly outputs: readonly [];
    readonly stateMutability: 'view';
  }
];

type ArrayAbi = readonly [
  {
    readonly type: 'function';
    readonly name: 'arrays';
    readonly inputs: readonly [
      { readonly type: 'bytes32[16]'; readonly name: 'fixed' },
      { readonly type: 'uint256[2][]'; readonly name: 'nested' },
      { readonly type: 'address[]'; readonly name: 'dynamic' }
    ];
    readonly outputs: readonly [{ readonly type: 'uint256[2][]'; readonly name: 'out' }];
    readonly stateMutability: 'view';
  }
];

describe('names: reads and writes are separate sets', () => {
  it('a view function is a read name and not a write name, and the reverse', () => {
    expectTypeOf<'balanceOf'>().toMatchTypeOf<ReadName<Token>>();
    expectTypeOf<'approve'>().toMatchTypeOf<WriteName<Token>>();
    expectTypeOf<'approve'>().not.toMatchTypeOf<ReadName<Token>>();
    expectTypeOf<'balanceOf'>().not.toMatchTypeOf<WriteName<Token>>();
  });

  it('an ABI typed only as readonly unknown[] has no callable names', () => {
    expectTypeOf<ReadName<readonly unknown[]>>().toBeNever();
    expectTypeOf<WriteName<readonly unknown[]>>().toBeNever();
  });
});

describe('type mapping', () => {
  it('integers are bigint on the way in and on the way out', () => {
    expectTypeOf<ReadArgs<Token, 'allowance'>>().toEqualTypeOf<readonly [string, string]>();
    expectTypeOf<WriteArgs<Token, 'approve'>>().toEqualTypeOf<readonly [string, bigint]>();
    expectTypeOf<ReadResult<Token, 'balanceOf'>>().toEqualTypeOf<bigint>();
  });

  it('a multi-output read is a positional tuple with the ABI types in order', () => {
    type Validator = ReadResult<Staking, 'validators'>;
    expectTypeOf<Validator[5]>().toEqualTypeOf<Hex>();
    expectTypeOf<Validator[7]>().toEqualTypeOf<bigint>();
    expectTypeOf<Validator['length']>().toEqualTypeOf<13>();
  });

  it('a bool is boolean', () => {
    expectTypeOf<ReadResult<Staking, 'locked'>>().toEqualTypeOf<boolean>();
  });

  it('an overloaded name takes the arguments of either overload', () => {
    type Args = WriteArgs<Nft, 'safeTransferFrom'>;
    expectTypeOf<readonly [string, string, bigint]>().toMatchTypeOf<Args>();
    expectTypeOf<readonly [string, string, bigint, string]>().toMatchTypeOf<Args>();
  });

  it('fixed-size and nested arrays map element by element', () => {
    type Args = ReadArgs<ArrayAbi, 'arrays'>;
    expectTypeOf<Args[0]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<Args[1]>().toEqualTypeOf<readonly (readonly bigint[])[]>();
    expectTypeOf<Args[2]>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<ReadResult<ArrayAbi, 'arrays'>>().toEqualTypeOf<readonly (readonly bigint[])[]>();
  });

  it('an unsupported Solidity type maps to never, so a call that needs it cannot compile', () => {
    expectTypeOf<ReadArgs<TupleAbi, 'takesTuple'>[0]>().toBeNever();
  });
});

describe('the class resolves a call to the typed signature', () => {
  it('reads return the ABI type', () => {
    const positive = async (): Promise<void> => {
      expectTypeOf(await token.read('balanceOf', [user])).toEqualTypeOf<bigint>();
      expectTypeOf(await staking.read('locked', [])).toEqualTypeOf<boolean>();
      const validator = await staking.read('validators', [1n]);
      expectTypeOf(validator[5]).toEqualTypeOf<Hex>();
      expectTypeOf(validator[7]).toEqualTypeOf<bigint>();
    };
    expectTypeOf(positive).toBeFunction();
  });

  it('writes, prepares and estimates accept both call shapes', () => {
    const positive = async (): Promise<void> => {
      expectTypeOf(await token.write('approve', [user, 1n])).toEqualTypeOf<TxResult>();
      expectTypeOf(
        await token.write({ method: 'approve', args: [user, 1n] })
      ).toEqualTypeOf<TxResult>();
      expectTypeOf(await token.prepareWrite('approve', [user, 1n])).toEqualTypeOf<PreparedTx>();
      expectTypeOf(
        await token.prepareWrite({ method: 'transfer', args: [user, 1n] })
      ).toEqualTypeOf<PreparedTx>();
      expectTypeOf(await token.estimateGas('approve', [user, 1n])).toEqualTypeOf<bigint>();
      expectTypeOf(
        await token.estimateGas({ method: 'approve', args: [user, 1n] })
      ).toEqualTypeOf<bigint>();
    };
    expectTypeOf(positive).toBeFunction();
  });

  it('a descriptor is a union of valid pairs, each carrying its own arguments', () => {
    type Call = WriteCall<Token>;
    expectTypeOf<{ method: 'approve'; args: readonly [string, bigint] }>().toMatchTypeOf<Call>();
    expectTypeOf<{ method: 'transfer'; args: readonly [string, bigint] }>().toMatchTypeOf<Call>();
  });
});

describe('what the compiler rejects', () => {
  it('a typo in the method name, or a name of the other kind', () => {
    const reject = (): void => {
      // @ts-expect-error typo'd method name
      void token.read('balanceOff', [user]);
      // @ts-expect-error a state-changing name given to read
      void token.read('approve', [user, 1n]);
      // @ts-expect-error a view name given to write
      void token.write('balanceOf', [user]);
      // @ts-expect-error a view name given to prepareWrite
      void token.prepareWrite('balanceOf', [user]);
      // @ts-expect-error a view name given to estimateGas
      void token.estimateGas('balanceOf', [user]);
    };
    expectTypeOf(reject).toBeFunction();
  });

  it('a method name typed as string, a result type chosen by the caller, or an ABI that is not const', () => {
    const reject = async (): Promise<void> => {
      // @ts-expect-error a name that is only known to be a string
      void token.read(looseName, [user]);
      // @ts-expect-error a name that is only known to be a string
      void token.write(looseName, [user, 1n]);
      // @ts-expect-error a name that is only known to be a string
      void token.prepareWrite(looseName, [user, 1n]);
      // @ts-expect-error a name that is only known to be a string
      void token.estimateGas(looseName, [user, 1n]);
      // @ts-expect-error the result type comes from the ABI, not from the caller
      void token.read<bigint>('balanceOf', [user]);
      // @ts-expect-error a caller over a non-const ABI has no callable names
      void untyped.read('balanceOf', [user]);
      // @ts-expect-error a caller over a non-const ABI has no callable names
      void untyped.write('approve', [user, 1n]);
    };
    expectTypeOf(reject).toBeFunction();
  });

  it('the wrong number or type of arguments', () => {
    const reject = (): void => {
      // @ts-expect-error one argument too few
      void token.write('approve', [user]);
      // @ts-expect-error one argument too many
      void token.read('balanceOf', [user, user]);
      // @ts-expect-error a hex string for a uint256
      void token.write('approve', [user, '0x01']);
      // @ts-expect-error a number for a uint256
      void token.write('approve', [user, 1]);
      // @ts-expect-error a boolean where an address goes
      void token.read('balanceOf', [true]);
    };
    expectTypeOf(reject).toBeFunction();
  });

  it('a result used as the wrong type', () => {
    const reject = async (): Promise<void> => {
      // @ts-expect-error a uint256 is a bigint, not a string
      const asString: string = await token.read('balanceOf', [user]);
      void asString;
    };
    expectTypeOf(reject).toBeFunction();
  });

  it("a method of another contract's ABI", () => {
    const reject = (): void => {
      // @ts-expect-error validators belongs to StakeManager, not to the token
      void token.read('validators', [1n]);
    };
    expectTypeOf(reject).toBeFunction();
  });

  it('a descriptor whose arguments belong to a different method, or to none', () => {
    const reject = (): void => {
      // @ts-expect-error approve carries (address, uint256), not a single address
      void token.write({ method: 'approve', args: [user] });
      // @ts-expect-error a method name the ABI does not have
      void token.write({ method: 'noSuchMethod', args: [] });
      // @ts-expect-error a view function is not a write call
      void token.prepareWrite({ method: 'balanceOf', args: [user] });
      // @ts-expect-error a hex string for a uint256 argument
      void token.estimateGas({ method: 'approve', args: [user, '0x01'] });
    };
    expectTypeOf(reject).toBeFunction();
  });
});
