import { describe, expect, expectTypeOf, it } from 'vitest';

import { info as mainnetInfo } from '@polygonlabs/meta/info/mainnet/v1';
import { info as amoyInfo } from '@polygonlabs/meta/info/testnet/amoy';

import type { NetworkAddresses } from '../../src/networks.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';

import { ContractNotAvailableOnNetworkError } from '../../src/errors.ts';
import {
  PLASMA_ADDRESS_KEYS,
  parsePlasmaAddresses,
  parsePlasmaIndex
} from '../../src/plasma/addresses.ts';
import { createAddressFetcher, trustedPredicates } from '../../src/services/address-service.ts';

/**
 * The Plasma address parser against `@polygonlabs/meta`'s generated `info`
 * snapshots, which are codegenned from the same `network/` JSON files the
 * live CDN serves, and against the flat `PlasmaAddresses` shape an override or
 * a pre-flattened mirror carries.
 */

const PLASMA_NESTED_KEYS = [
  'DepositManagerProxy',
  'WithdrawManagerProxy',
  'ERC20Predicate',
  'ExitNFT'
];

/** The mainnet index with `mutate` applied to a copy of `Main.Contracts`. */
function mainnetWithContracts(mutate: (contracts: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(mainnetInfo);
  const contracts: Record<string, unknown> = copy.Main.Contracts;
  mutate(contracts);
  return copy;
}

/** The error a call throws, or `null`. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return null;
}

/** The bridge parser's output for `raw`, read through the public override path. */
async function bridgeParse(raw: unknown): Promise<NetworkAddresses> {
  const fetcher = createAddressFetcher({ network: 'mainnet', initial: raw });
  return { ...(await fetcher.get()) };
}

const FLAT: PlasmaAddresses = {
  RootChain: '0x1111111111111111111111111111111111111111',
  DepositManager: '0x2222222222222222222222222222222222222222',
  WithdrawManager: '0x3333333333333333333333333333333333333333',
  PlasmaERC20Predicate: '0x4444444444444444444444444444444444444444',
  ExitNFT: '0x5555555555555555555555555555555555555555',
  MaticToken: '0x6666666666666666666666666666666666666666',
  PolToken: '0x7777777777777777777777777777777777777777'
};

describe('PLASMA_ADDRESS_KEYS', () => {
  it('lists exactly the keys of PlasmaAddresses', () => {
    expectTypeOf<(typeof PLASMA_ADDRESS_KEYS)[number]>().toEqualTypeOf<keyof PlasmaAddresses>();
    expect([...PLASMA_ADDRESS_KEYS].sort()).deep.equals(Object.keys(FLAT).sort());
  });
});

describe('parsePlasmaIndex — nested CDN shape (meta snapshot fixtures)', () => {
  it('parses the nested fixture on both networks, reading the live proxies', () => {
    for (const [network, info] of [
      ['mainnet', mainnetInfo],
      ['amoy', amoyInfo]
    ] as const) {
      const out = parsePlasmaIndex({ network, raw: info });
      const contracts = info.Main.Contracts;
      expect(out).property('RootChain').equals(contracts.RootChainProxy);
      expect(out).property('DepositManager').equals(contracts.DepositManagerProxy);
      expect(out).property('WithdrawManager').equals(contracts.WithdrawManagerProxy);
      expect(out).property('PlasmaERC20Predicate').equals(contracts.ERC20Predicate);
      expect(out).property('ExitNFT').equals(contracts.ExitNFT);
      expect(out).property('MaticToken').equals(contracts.Tokens.MaticToken);
      expect(out).property('PolToken').equals(contracts.PolygonEcosystemToken);
      expect(Object.keys(out).sort()).deep.equals([...PLASMA_ADDRESS_KEYS].sort());
    }
  });

  it('never reads an implementation entry in place of its proxy', () => {
    const out = parsePlasmaIndex({ network: 'mainnet', raw: mainnetInfo });
    const contracts = mainnetInfo.Main.Contracts;
    expect(out.DepositManager).not.equals(contracts.DepositManager);
    expect(out.WithdrawManager).not.equals(contracts.WithdrawManager);
  });

  it('keeps the Plasma predicate apart from the PoS predicate', async () => {
    const plasma = parsePlasmaIndex({ network: 'mainnet', raw: mainnetInfo });
    const bridge = await bridgeParse(mainnetInfo);
    expect(plasma)
      .property('PlasmaERC20Predicate')
      .equals(mainnetInfo.Main.Contracts.ERC20Predicate);
    expect(plasma.PlasmaERC20Predicate).not.equals(bridge.ERC20Predicate);
    expect(bridge)
      .property('ERC20Predicate')
      .equals(mainnetInfo.Main.POSContracts.ERC20PredicateProxy);
  });

  it('does not trust the Plasma predicate as a PoS approval spender', async () => {
    const plasma = parsePlasmaIndex({ network: 'mainnet', raw: mainnetInfo });
    const bridge = await bridgeParse(mainnetInfo);
    const trusted = trustedPredicates(bridge);
    expect(trusted).not.contain(plasma.PlasmaERC20Predicate);
    expect(trusted).contain(mainnetInfo.Main.POSContracts.ERC20PredicateProxy);
  });

  it('refuses a nested index that lacks the Plasma keys, naming every one', () => {
    const err = thrownBy(() =>
      parsePlasmaIndex({
        network: 'mainnet',
        raw: mainnetWithContracts((contracts) => {
          for (const key of PLASMA_NESTED_KEYS) delete contracts[key];
        })
      })
    );
    expect(err).instanceOf(ContractNotAvailableOnNetworkError);
    expect(err)
      .nested.property('info.missing')
      .deep.equals(['DepositManager', 'WithdrawManager', 'PlasmaERC20Predicate', 'ExitNFT']);
    expect(err)
      .property('message')
      .equals(
        'Address index for mainnet lacks Plasma contracts: DepositManager, WithdrawManager, PlasmaERC20Predicate, ExitNFT'
      );
  });

  it('reports a malformed Plasma address as missing instead of keeping it', () => {
    const err = thrownBy(() =>
      parsePlasmaIndex({
        network: 'mainnet',
        raw: mainnetWithContracts((contracts) => {
          contracts.DepositManagerProxy = '0x1234';
          contracts.ExitNFT = 42;
        })
      })
    );
    expect(err).instanceOf(ContractNotAvailableOnNetworkError);
    expect(err).nested.property('info.network').equals('mainnet');
    expect(err).nested.property('info.missing').deep.equals(['DepositManager', 'ExitNFT']);
  });

  it('still parses a nested index whose PoS keys are missing or malformed', () => {
    const broken = structuredClone(mainnetInfo) as unknown as {
      Main: { POSContracts: Record<string, unknown> };
    };
    delete broken.Main.POSContracts.RootChainManagerProxy;
    broken.Main.POSContracts.ERC20PredicateProxy = 'not-an-address';
    const out = parsePlasmaIndex({ network: 'mainnet', raw: broken });
    expect(out).property('DepositManager').equals(mainnetInfo.Main.Contracts.DepositManagerProxy);
  });

  it('rejects a body that is not a JSON object', () => {
    for (const raw of [null, 'x', 7]) {
      const err = thrownBy(() => parsePlasmaIndex({ network: 'mainnet', raw }));
      expect(err).property('name').equals('BridgeEventDecodeFailedError');
      expect(err).property('message').contains('expected JSON object');
    }
  });
});

describe('parsePlasmaIndex — flat mirror', () => {
  it('reads the seven Plasma keys from the flat shape, ignoring PoS keys beside them', () => {
    const out = parsePlasmaIndex({
      network: 'amoy',
      raw: { ...FLAT, RootChainManager: '0x8888888888888888888888888888888888888888' }
    });
    expect(out).deep.equals(FLAT);
  });

  it('refuses a flat shape with a malformed key, naming it', () => {
    const err = thrownBy(() =>
      parsePlasmaIndex({ network: 'amoy', raw: { ...FLAT, ExitNFT: 'not-an-address' } })
    );
    expect(err).instanceOf(ContractNotAvailableOnNetworkError);
    expect(err).nested.property('info.missing').deep.equals(['ExitNFT']);
  });
});

describe('parsePlasmaAddresses', () => {
  it('returns a copy, so the caller cannot mutate the override it passed', () => {
    const out = parsePlasmaAddresses({ network: 'amoy', addresses: FLAT });
    expect(out).deep.equals(FLAT);
    expect(out).not.equals(FLAT);
  });

  it('drops keys outside the Plasma set', () => {
    const withExtra = { ...FLAT, StakeManager: '0x8888888888888888888888888888888888888888' };
    const out = parsePlasmaAddresses({ network: 'amoy', addresses: withExtra });
    expect(out).not.property('StakeManager');
  });

  it('names every absent or malformed key in one ContractNotAvailableOnNetworkError', () => {
    const err = thrownBy(() =>
      parsePlasmaAddresses({
        network: 'mainnet',
        addresses: { ...FLAT, ExitNFT: '0x12', PolToken: undefined }
      })
    );
    expect(err).instanceOf(ContractNotAvailableOnNetworkError);
    expect(err).nested.property('info.network').equals('mainnet');
    expect(err).nested.property('info.missing').deep.equals(['ExitNFT', 'PolToken']);
    expect(err)
      .property('message')
      .equals('Plasma addresses for mainnet lack valid entries: ExitNFT, PolToken');
  });
});
