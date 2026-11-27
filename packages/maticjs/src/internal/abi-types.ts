/**
 * Types only: what an `as const` contract ABI says about each function's
 * name, argument list and result, so a contract call is checked by the
 * compiler instead of by a string at run time.
 *
 * This is a local mapping rather than `abitype`: `abitype` is reachable only
 * through `viem`, an optional peer, so the SDK's own declarations cannot
 * import it, and it maps small integers to `number` whereas the SDK returns
 * `bigint` for every integer on every library.
 *
 * The mapping must agree with the run-time decoder in `decode.ts`, which
 * walks the same ABI. TypeScript cannot prove that, so the agreement test
 * over every vendored ABI does.
 *
 * A Solidity type this file does not know (a tuple, say) maps to `never`, so
 * a call that needs it does not compile rather than being typed loosely.
 */

import type { Hex } from '../adapter.js';

export interface AbiParameter {
  readonly type: string;
  readonly name?: string;
}

export interface AbiFunction {
  readonly type: 'function';
  readonly name: string;
  readonly inputs: readonly AbiParameter[];
  readonly outputs?: readonly AbiParameter[];
  readonly stateMutability: 'view' | 'pure' | 'nonpayable' | 'payable';
}

/**
 * Anything an ABI can be. Only an `as const` ABI carries names, so for an ABI
 * typed as plain `readonly unknown[]` no function name is valid.
 */
export type Abi = readonly unknown[];

type FunctionsOf<TAbi extends Abi> = Extract<TAbi[number], AbiFunction>;
type ReadFunctionsOf<TAbi extends Abi> = Extract<
  FunctionsOf<TAbi>,
  { readonly stateMutability: 'view' | 'pure' }
>;
type WriteFunctionsOf<TAbi extends Abi> = Extract<
  FunctionsOf<TAbi>,
  { readonly stateMutability: 'nonpayable' | 'payable' }
>;

/** Names of the `view` and `pure` functions of the ABI. */
export type ReadName<TAbi extends Abi> = ReadFunctionsOf<TAbi>['name'];
/** Names of the state-changing functions of the ABI. */
export type WriteName<TAbi extends Abi> = WriteFunctionsOf<TAbi>['name'];

/** Addresses stay `string` until the public parameters become `Hex`. */
export type AddressInput = string;
export type BytesInput = string;
/** Integers are `bigint` only: a `number` or a hex string for a `uint256` does not compile. */
export type IntegerInput = bigint;

/**
 * The type of an array's element: the last dimension is removed, so
 * `uint256[2][]` gives `uint256[2]` and `uint256[2]` gives `uint256`.
 */
type ArrayElement<T extends string> = T extends `${infer Head}[${infer Tail}`
  ? Tail extends `${string}[${string}`
    ? `${Head}[${ArrayElement<Tail>}`
    : Head
  : never;

type InputOf<T extends string> = T extends `${string}]`
  ? readonly InputOf<ArrayElement<T>>[]
  : T extends 'address'
    ? AddressInput
    : T extends 'bool'
      ? boolean
      : T extends 'string'
        ? string
        : T extends `bytes${string}`
          ? BytesInput
          : T extends `uint${string}` | `int${string}`
            ? IntegerInput
            : never;

type OutputOf<T extends string> = T extends `${string}]`
  ? readonly OutputOf<ArrayElement<T>>[]
  : T extends 'address'
    ? Hex
    : T extends 'bool'
      ? boolean
      : T extends 'string'
        ? string
        : T extends `bytes${string}`
          ? Hex
          : T extends `uint${string}` | `int${string}`
            ? bigint
            : never;

type InputsOf<P extends readonly AbiParameter[]> = {
  readonly [K in keyof P]: P[K] extends AbiParameter ? InputOf<P[K]['type']> : never;
};
type OutputsOf<P extends readonly AbiParameter[]> = {
  readonly [K in keyof P]: P[K] extends AbiParameter ? OutputOf<P[K]['type']> : never;
};

type Named<F extends AbiFunction, N extends string> = Extract<F, { readonly name: N }>;

/**
 * The argument list of a function. An overloaded name (`safeTransferFrom`)
 * gives the union of its argument lists.
 */
type ArgsOf<F> = F extends AbiFunction ? InputsOf<F['inputs']> : never;

export type ReadArgs<TAbi extends Abi, N extends ReadName<TAbi>> = ArgsOf<
  Named<ReadFunctionsOf<TAbi>, N>
>;
export type WriteArgs<TAbi extends Abi, N extends WriteName<TAbi>> = ArgsOf<
  Named<WriteFunctionsOf<TAbi>, N>
>;

/**
 * What a read of the function gives back: the bare value for one output, a
 * positional readonly tuple for several.
 */
export type ReadResult<TAbi extends Abi, N extends ReadName<TAbi>> =
  Named<ReadFunctionsOf<TAbi>, N> extends infer F
    ? F extends { readonly outputs: infer O extends readonly AbiParameter[] }
      ? O extends readonly [infer Only extends AbiParameter]
        ? OutputOf<Only['type']>
        : OutputsOf<O>
      : never
    : never;

/**
 * Every valid `{ method, args }` pair of the ABI's write functions. Built so
 * that `args` is correlated with `method`: a descriptor for `approve` cannot
 * carry the arguments of `transfer`. For the two call builders that choose
 * between methods at run time.
 */
export type WriteCall<TAbi extends Abi> = {
  readonly [N in WriteName<TAbi>]: {
    readonly method: N;
    readonly args: WriteArgs<TAbi, N>;
  };
}[WriteName<TAbi>];
