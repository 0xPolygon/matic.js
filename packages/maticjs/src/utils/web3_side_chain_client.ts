import type { BaseWeb3Client } from '../abstracts';
import type { IBaseClientConfig } from '../interfaces';

import { utils } from '..';
import { ABIManager } from '../utils';
import { Logger } from './logger';

const chainIdToConfigPath = {
  1: 'Main',
  5: 'Main',
  11155111: 'Main',
  137: 'Matic',
  80001: 'Matic',
  80002: 'Matic',
  1442: 'zkEVM',
  2442: 'zkEVM',
  1101: 'zkEVM'
};

export class Web3SideChainClient<T_CONFIG> {
  parent: BaseWeb3Client;
  child: BaseWeb3Client;

  config: T_CONFIG;

  abiManager: ABIManager;

  logger = new Logger();
  resolution: unknown = {};

  init(config: IBaseClientConfig) {
    const normalizedConfig = config || ({} as any);
    normalizedConfig.parent.defaultConfig = normalizedConfig.parent.defaultConfig || ({} as any);
    normalizedConfig.child.defaultConfig = normalizedConfig.child.defaultConfig || ({} as any);
    this.config = normalizedConfig as any;

    // tslint:disable-next-line
    const Web3Client = utils.Web3Client;

    if (!Web3Client) {
      throw new Error('Web3Client is not set');
    }

    if (utils.UnstoppableDomains) {
      this.resolution = utils.UnstoppableDomains;
    }

    this.parent = new (Web3Client as any)(normalizedConfig.parent.provider, this.logger);
    this.child = new (Web3Client as any)(normalizedConfig.child.provider, this.logger);

    this.logger.enableLog(normalizedConfig.log);

    const network = normalizedConfig.network;
    const version = normalizedConfig.version;
    const abiManager = (this.abiManager = new ABIManager(network, version));
    this.logger.log('init called', abiManager);
    return abiManager.init().catch((err) => {
      // Preserve the underlying fetch/parse failure instead of discarding it.
      const reason = err instanceof Error ? err.message : String(err);
      // `cause` via assignment: the Error(message, { cause }) overload postdates
      // this package's TS lib target.
      throw Object.assign(
        new Error(`network ${network} - ${version} is not supported: ${reason}`),
        { cause: err }
      );
    });
  }

  getABI(name: string, type?: string) {
    return this.abiManager.getABI(name, type);
  }

  getConfig(path: string) {
    return this.abiManager.getConfig(path);
  }

  get mainPlasmaContracts() {
    return this.getConfig('Main.Contracts');
  }

  get mainPOSContracts() {
    return this.getConfig('Main.POSContracts');
  }

  get mainZkEvmContracts() {
    return this.getConfig('Main.Contracts');
  }

  get zkEvmContracts() {
    return this.getConfig('zkEVM.Contracts');
  }

  isEIP1559Supported(chainId: number): boolean {
    return this.getConfig(`${chainIdToConfigPath[chainId]}.SupportsEIP1559`);
  }
}
