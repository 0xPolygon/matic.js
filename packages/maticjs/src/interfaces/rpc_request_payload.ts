/**
 * JSON-RPC request payload shape. `params` is an opaque array — the
 * SDK forwards it through to the underlying provider without
 * inspection.
 */
export interface IJsonRpcRequestPayload {
  jsonrpc: string;
  method: string;
  params: readonly unknown[];
  id?: string | number;
}
