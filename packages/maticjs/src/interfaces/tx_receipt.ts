export interface ITransactionReceipt {
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  blockNumber: number;
  from: string;
  to: string;
  contractAddress: string;
  cumulativeGasUsed: number;
  gasUsed: number;
  logs?: ILog[];
  events?: {
    [eventName: string]: IEventLog;
  };
  status: boolean;
  logsBloom: string;
  root: string;
  type: string;
}

export interface ILog {
  address: string;
  data: string;
  topics: string[];
  logIndex: number;
  transactionHash: string;
  transactionIndex: number;
  blockHash: string;
  blockNumber: number;
}

export interface IEventLog {
  event: string;
  address: string;
  returnValues: Record<string, unknown>;
  logIndex: number;
  transactionIndex: number;
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  raw?: { data: string; topics: string[] };
}
