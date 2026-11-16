/**
 * JSON-RPC response shape. `result` is opaque — the consumer narrows
 * once it knows the request method.
 */
export interface IJsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: string;
}
