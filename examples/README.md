# Examples

Runnable scripts demonstrating `@polygonlabs/maticjs` against the
Polygon PoS bridge. Each file is self-contained — you can copy any of
them into your own project and adjust the imports.

| File              | Parent client | Child client |
| ----------------- | ------------- | ------------ |
| `viem.ts`         | viem          | viem         |
| `ethers-v5.ts`    | ethers v5     | ethers v5    |
| `ethers-v6.ts`    | ethers v6     | ethers v6    |

All three perform the same flow:

1. Build a `POSClient` against Amoy (testnet).
2. Read the parent-chain ERC-20 balance.
3. Submit an `approve(...)` to the bridge predicate.
4. Wait for the receipt via `result.confirmed()`.

The actual `deposit(...)` call is left commented in `viem.ts` — uncomment
once you are happy with the wiring; on Amoy a deposit costs sepolia ETH.

## Running

These examples are intentionally **not** part of the pnpm workspace —
they import `@polygonlabs/maticjs` exactly the way an external consumer
would, wired to the local build via a `link:` dependency. Two options
for running them locally:

### Against the local build

```bash
# build the SDK once
pnpm --filter @polygonlabs/maticjs run build

# install the examples' own deps (link:ed SDK + viem + ethers)
cd examples && pnpm install --ignore-workspace

# run (Node >= 24 executes TypeScript natively)
PARENT_RPC=https://...sepolia.example \
CHILD_RPC=https://rpc-amoy.polygon.technology \
PARENT_TOKEN=0xYourTestERC20OnSepolia \
PRIVATE_KEY=0xYourTestPrivateKey \
  node viem.ts
```

### Against the published npm package

If you copy one of these files into your own project:

```bash
pnpm add @polygonlabs/maticjs viem    # or ethers
node yourfile.ts                      # Node >= 24 (native TS)
# On Node 22, compile with tsc first (or port the ~80 lines to .mjs).
```

## Required environment variables

Every example reads these — running without them prints a clear
`set <NAME>=...` and exits non-zero:

| Variable       | Purpose |
| -------------- | ------- |
| `PARENT_RPC`   | RPC URL for the parent chain (sepolia for `network: 'amoy'`, mainnet for `network: 'mainnet'`) |
| `CHILD_RPC`    | RPC URL for the Polygon chain (`https://rpc-amoy.polygon.technology` for amoy) |
| `PARENT_TOKEN` | Address of the bridged ERC-20 on the parent chain |
| `PRIVATE_KEY`  | Hex private key for the account submitting the approve |

**Use a fresh test-only key.** None of these scripts hold or read
funds from anything other than the account you supply, but the value
you pass in is loaded into a `Wallet` / `account` object and used to
sign live transactions.
