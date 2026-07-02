# @polygonlabs/pos-sdk

[![npm version](https://img.shields.io/npm/v/@polygonlabs/pos-sdk.svg)](https://www.npmjs.com/package/@polygonlabs/pos-sdk)
[![CI](https://github.com/0xPolygon/matic.js/actions/workflows/ci-trigger.yml/badge.svg?branch=master)](https://github.com/0xPolygon/matic.js/actions/workflows/ci-trigger.yml)
[![License: MIT](https://img.shields.io/npm/l/@polygonlabs/pos-sdk.svg)](LICENSE)

TypeScript SDK for the Polygon PoS bridge. Drives ERC-20, ERC-721,
ERC-1155 and native-ETH deposits, child-chain withdrawals, and exit
proofs against `RootChainManager`. Works with `viem`, `ethers v5`, and
`ethers v6` — pick whichever you already have; the SDK adapts.

This repository is the home of `@polygonlabs/pos-sdk` (1.0+). It
supersedes the `@maticnetwork/maticjs` (0.x / 3.x) line — see the
[migration guide](packages/pos-sdk/MIGRATION.md) if you are coming from
there.

## Install

```bash
pnpm add @polygonlabs/pos-sdk viem      # or
pnpm add @polygonlabs/pos-sdk ethers    # v5 or v6
```

`viem` and `ethers` are optional peer dependencies; install only the one
you actually use. Static imports of either library are kept type-only
inside the SDK so the absent peer never crashes module load.

## Quickstart (viem)

```ts
import { createPublicClient, createWalletClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { POSClient } from '@polygonlabs/pos-sdk';
import { viemAdapter } from '@polygonlabs/pos-sdk/viem';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const parentPublic = createPublicClient({ chain: sepolia, transport: http(process.env.PARENT_RPC) });
const parentWallet = createWalletClient({ account, chain: sepolia, transport: http(process.env.PARENT_RPC) });

const childPublic  = createPublicClient({ transport: http(process.env.CHILD_RPC)  });
const childWallet  = createWalletClient({ account, transport: http(process.env.CHILD_RPC)  });

const pos = await POSClient.init({
  network: 'amoy',
  parent: viemAdapter({ public: parentPublic, wallet: parentWallet }),
  child:  viemAdapter({ public: childPublic,  wallet: childWallet  })
});

// Read: balance of the bridged ERC-20 on the parent chain.
const erc20 = pos.parent.erc20(process.env.PARENT_TOKEN as `0x${string}`);
const balance = await erc20.getBalance(account.address);

// Write: approve the bridge predicate, then wait for inclusion.
const approve = await erc20.approve(1_000_000n);
console.log('approve hash:', approve.hash);
const receipt = await approve.confirmed();
console.log('approve mined in block:', receipt.blockNumber);
```

Two things worth flagging in that snippet:

- **`TxResult.confirmed()`.** Every write returns a `TxResult` with the
  hash already populated. The receipt is fetched lazily by calling
  `.confirmed()`, and the result is memoised — call it twice and you
  get equivalent receipts without polling the chain twice. This
  separation replaces the legacy `getTransactionHash()` / `getReceipt()`
  pattern, which conflated "submitted" and "mined" in a single
  awaitable.

- **No address constants.** `POSClient.init` validates configuration by
  fetching the active address index for `network` from the Polygon CDN
  (`https://static.polygon.technology/network/<network>/v1/index.json`),
  caches it for one hour, and serves cached values stale-while-
  revalidate. **Long-running services pick up Polygon contract
  redeployments without a restart.** Override the cache TTL or supply
  pre-resolved addresses via `addresses?: NetworkAddresses` for
  air-gapped deployments — see `POSClientConfig` in
  [`src/pos-client.ts`](packages/pos-sdk/src/pos-client.ts).

## Examples

Runnable scripts for all three peer-dep flavours live in
[`examples/`](examples/):

- [`viem.ts`](examples/viem.ts) — quickstart with viem
- [`ethers-v5.ts`](examples/ethers-v5.ts) — same flow with ethers v5
- [`ethers-v6.ts`](examples/ethers-v6.ts) — same flow with ethers v6

See [`examples/README.md`](examples/README.md) for the env vars each
script needs.

## Migration from `@maticnetwork/maticjs`

If you are upgrading a service from the 0.x / 3.x line, read
[`packages/pos-sdk/MIGRATION.md`](packages/pos-sdk/MIGRATION.md). The
1.0 release renames the package, drops the plugin layer, switches
amounts to native `bigint`, and renames a handful of methods —
nothing that requires a deep rethink, but everything is a breaking
change at the type level.

## Development

This is a pnpm monorepo. The published package lives in
`packages/pos-sdk/`; `examples/` and `manual/` (if present) are
standalone, intentionally not part of the workspace.

```bash
pnpm install                       # bootstrap
pnpm run lint                      # ESLint across the workspace
pnpm run typecheck                 # tsc --noEmit
pnpm --filter @polygonlabs/pos-sdk run build
pnpm --filter @polygonlabs/pos-sdk run test
```

Releases are managed via [changesets](https://github.com/changesets/changesets).
The release workflow publishes automatically on merge to `master`.

## Support

Reach the team on [Discord](https://discord.com/invite/0xpolygonrnd) or
file an issue at <https://github.com/0xPolygon/matic.js/issues>.

## License

[MIT](LICENSE).
