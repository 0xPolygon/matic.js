import { BaseWeb3Client } from '../abstracts';
import { EmptyBigNumber } from '../implementation';
import { Converter } from './converter';

export * from './use';
export * from './event_bus';
export * from './logger';
export * from './merge';
export * from './map_promise';
export * from './retry';
export * from './proof_util';
export * from './http_request';
export * from './converter';
export * from './web3_side_chain_client';
export * from './base_token';
export * from './set_proof_api_url';
export * from './resolve';
export * from './promise_resolve';
export * from './bridge_client';
export * from './abi_manager';
export * from './not_implemented';
export * from './zkevm_bridge_client';
export * from './buffer-utils';
export * from './keccak';
export * from './types';

export const utils = {
  converter: Converter,
  Web3Client: BaseWeb3Client,
  BN: EmptyBigNumber,
  UnstoppableDomains: Object
};
