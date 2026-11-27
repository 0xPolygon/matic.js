/**
 * Which adapters are the SDK's own.
 *
 * A read result that does not match the ABI is worded differently depending on
 * who produced it: a hand-written adapter is told what its `read()` must
 * return, while a mismatch from the viem, ethers v5 or ethers v6 adapter is
 * the SDK's bug and is reported as such. The decoder therefore has to know
 * which kind it is looking at.
 *
 * Each built-in adapter registers itself here when it is constructed. The
 * registry is a module of its own, free of any web3 import, because it is
 * loaded from the root entry (through the decoder) as well as from each
 * adapter entry: if it lived in an adapter module, the root entry would pull
 * viem or ethers in to ask the question. The build hoists a module shared by
 * several entries into one chunk, so every entry sees the same set.
 *
 * A registry, not a member of the `Adapter` interface or of the adapter
 * classes: the interface is public and consumers implement it, and a new
 * member on a class would change its published declarations.
 */

const builtInAdapters = new WeakSet<object>();

/** Record `adapter` as one of the SDK's own; called from each built-in adapter's constructor. */
export const markBuiltInAdapter = (adapter: object): void => {
  builtInAdapters.add(adapter);
};

/** Whether `adapter` is one of the SDK's own (viem, ethers v5, ethers v6) and not hand-written. */
export const isBuiltInAdapter = (adapter: object): boolean => builtInAdapters.has(adapter);
