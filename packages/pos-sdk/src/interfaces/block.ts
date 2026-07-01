export interface IBaseBlock {
  size: number;
  difficulty: number;
  totalDifficulty: number;
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
