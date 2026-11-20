import { describe, expectTypeOf, it } from 'vitest';

import type { Adapter, Hex } from '../../src/adapter.ts';
import type { PlasmaAddresses } from '../../src/plasma/addresses.ts';
import type {
  PlasmaChildERC20,
  PlasmaClient,
  PlasmaClientConfig,
  PlasmaParentERC20
} from '../../src/plasma/index.ts';

/**
 * Type-level guarantees for the Plasma entry. A config that passes fixed
 * `addresses` never reads the address index, so index options beside it
 * would be silently ignored; and a token handle on one chain has no use for
 * the other chain's methods, which only throw. Checked by `tsc` (the test
 * files are in the typecheck project), so an unused `@ts-expect-error`
 * below fails typecheck. The checked bodies are never called: a call would
 * need real adapters, and the compiler is the subject.
 */

interface Fixtures {
  parent: Adapter;
  child: Adapter;
  addresses: PlasmaAddresses;
  plasma: PlasmaClient;
  token: Hex;
  burnTxHash: string;
}

describe('PlasmaClientConfig', () => {
  it('accepts fixed addresses alone, and the index options without addresses', () => {
    const accept = ({ parent, child, addresses }: Fixtures): PlasmaClientConfig[] => [
      { network: 'mainnet', parent, child, addresses },
      { network: 'mainnet', parent, child },
      {
        network: 'mainnet',
        parent,
        child,
        addressIndexUrl: 'https://example.invalid',
        addressTTLMs: 1000,
        onAddressRefreshError: () => undefined
      }
    ];
    expectTypeOf(accept).toBeFunction();
  });

  it('rejects the index options beside addresses at compile time', () => {
    const reject = ({ parent, child, addresses }: Fixtures): PlasmaClientConfig[] => [
      // @ts-expect-error — addressIndexUrl is ignored when addresses is given
      { network: 'mainnet', parent, child, addresses, addressIndexUrl: 'https://example.invalid' },
      // @ts-expect-error — addressTTLMs is ignored when addresses is given
      { network: 'mainnet', parent, child, addresses, addressTTLMs: 1000 },
      // @ts-expect-error — onAddressRefreshError is ignored when addresses is given
      { network: 'mainnet', parent, child, addresses, onAddressRefreshError: () => undefined }
    ];
    expectTypeOf(reject).toBeFunction();
  });
});

describe('Plasma token handle views', () => {
  it('types parent and child handles as their own side', () => {
    const handles = ({ plasma, token }: Fixtures): void => {
      expectTypeOf(plasma.parent.erc20(token)).toEqualTypeOf<PlasmaParentERC20>();
      expectTypeOf(plasma.child.erc20(token)).toEqualTypeOf<PlasmaChildERC20>();
    };
    expectTypeOf(handles).toBeFunction();
  });

  it('rejects a call that is only valid on the other chain at compile time', () => {
    const reject = ({ plasma, token, burnTxHash }: Fixtures): void => {
      // @ts-expect-error — confirming an exit is a parent-chain call
      void plasma.child.erc20(token).confirmWithdraw(burnTxHash);
      // @ts-expect-error — the burn is a child-chain call
      void plasma.parent.erc20(token).startWithdraw(1n);
      // @ts-expect-error — depositing is a parent-chain call
      void plasma.child.erc20(token).deposit(1n, token);
      // @ts-expect-error — the burn has no prepare sibling on the parent chain
      void plasma.parent.erc20(token).prepareStartWithdraw(1n);
    };
    expectTypeOf(reject).toBeFunction();
  });

  it('keeps the calls that are valid on each side', () => {
    const accept = ({ plasma, token, burnTxHash }: Fixtures): void => {
      void plasma.parent.erc20(token).confirmWithdraw(burnTxHash);
      void plasma.parent.erc20(token).getWithdrawStatus({ burnTxHash });
      void plasma.parent.erc20(token).getBalance(token);
      void plasma.child.erc20(token).startWithdraw(1n);
      void plasma.child.erc20(token).getBalance(token);
    };
    expectTypeOf(accept).toBeFunction();
  });
});
