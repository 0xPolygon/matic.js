// Stage 2 narrowed every internal numeric API to native `bigint`.
//
// The legacy `TYPE_AMOUNT` placeholder (originally a union of
// BN.js/`BaseBigNumber`/string/number) is gone — token methods that
// used to accept it now accept `bigint` directly. The 1155 parameter
// shapes live alongside their owning class in `pos/erc1155.ts` and are
// re-exported from there; this file is intentionally empty so the
// barrel `export * from './types/index.js'` keeps working.
export {};
