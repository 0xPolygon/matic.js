import type { ITransactionRequestConfig } from './transaction_config.js';

/**
 * Per-call transaction options. Stage 3's API redesign drops the legacy
 * `returnTransaction?: boolean` field — the new convention is that
 * every write returns a `TxResult` whose `confirmed()` waits for the
 * receipt; consumers wanting unsigned-tx data construct it from the
 * vendored ABI and never go through the SDK's write path.
 *
 * Now a type alias rather than an interface — the legacy interface
 * existed only to add the `returnTransaction` flag; with that gone,
 * `ITransactionOption` is structurally identical to its base.
 */
export type ITransactionOption = ITransactionRequestConfig;
