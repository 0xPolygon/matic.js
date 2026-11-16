export interface IBaseBlock {
  size: number;
  difficulty: number;
  /**
   * Absent on modern RPC responses: geth removed `totalDifficulty` from
   * `eth_getBlockByNumber` in v1.14 (post-merge it is meaningless) and
   * current bor endpoints inherited that. Nothing in the proof pipeline
   * consumes it — kept optional only for shape compatibility.
   */
  totalDifficulty?: number;
  uncles: string[];
  number: number;
  hash: string;
  parentHash: string;
  nonce: string;
  sha3Uncles: string;
  logsBloom: string;
  transactionsRoot: string;
  stateRoot: string;
  receiptsRoot: string;
  miner: string;
  extraData: string;
  gasLimit: number;
  gasUsed: number;
  timestamp: number | string;
  baseFeePerGas?: string;
}

export interface IBlock extends IBaseBlock {
  transactions: string[];
}
