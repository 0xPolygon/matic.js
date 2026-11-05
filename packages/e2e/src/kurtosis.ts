/**
 * Reads the devnet the e2e tier runs against. Two modes, one return shape:
 *
 * - **Snapshot mode** (`E2E_SNAPSHOT_ADDRESSES_JSON` set): a kurtosis-pos
 *   snapshot restored with `docker compose`. There is no enclave to query;
 *   addresses come from the `contractAddresses.json` extracted from the
 *   snapshot image, and the RPC ports are the fixed host ports the snapshot's
 *   compose file publishes.
 * - **Cold-start mode** (default): a running kurtosis enclave. RPC URLs come
 *   from `kurtosis port print`, addresses from `kurtosis files inspect`.
 *
 * Only `readDevnet()` and the teardown record cross this module's boundary,
 * so callers never branch on the mode.
 *
 * Every kurtosis CLI call goes through `kurtosis()`, which first checks
 * `kurtosis engine status`. That check matters: `enclave inspect`,
 * `port print` and `files inspect` silently START an engine when none is
 * running, and an auto-started engine leaves otel containers behind that
 * `kurtosis engine stop` does not remove. With no engine running there can
 * be no running enclave, so the harness fails fast instead of creating
 * containers it would then have to clean up.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { getAddress, isAddress } from 'viem';
import { z } from 'zod';

import { VError } from '@polygonlabs/verror';

const KURTOSIS = process.env['KURTOSIS_BIN'] ?? 'kurtosis';
const ENCLAVE = process.env['KURTOSIS_ENCLAVE'] ?? 'pos';

// Chain ids are baked into the kurtosis-pos genesis and contract bytecode.
// `scripts/up.ts` checks both against `eth_chainId` before exporting them.
export const DEVNET_L1_CHAIN_ID = 3151908;
export const DEVNET_L2_CHAIN_ID = 4927;

// Fixed host ports published by the kurtosis-pos snapshot's docker-compose
// file (L1 EL 8545, L2 EL 9545, heimdall REST 1317).
const SNAPSHOT_L1_RPC_URL = 'http://127.0.0.1:8545';
const SNAPSHOT_L2_RPC_URL = 'http://127.0.0.1:9545';
const SNAPSHOT_HEIMDALL_REST_URL = 'http://127.0.0.1:1317';

// The kurtosis-pos admin account. This is PUBLIC devnet material, documented
// in kurtosis-pos ("interact with the devnet") and funded only on the local
// devnet. It is not a secret and controls nothing outside the devnet.
const DEVNET_ADMIN_PRIVATE_KEY =
  '0xd40311b5a5ca5eaeb48dfba5403bde4993ece8eccf4190e98e19fcd4754260ea';
const DEVNET_ADMIN_ADDRESS = '0x74Ed6F462Ef4638dc10FFb05af285e8976Fb8DC9';

export const AddressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), 'must be a 0x-prefixed address')
  .transform((value) => getAddress(value));

export const PrivateKeySchema = z.custom<`0x${string}`>(
  (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value),
  'must be a 0x-prefixed 32-byte hex private key'
);

/**
 * The subset of kurtosis-pos's `contractAddresses.json` the tier uses. Only
 * these keys are read; the artifact carries many more.
 */
const ContractAddressesArtifactSchema = z.object({
  root: z.object({
    RootChainProxy: AddressSchema,
    StakeManagerProxy: AddressSchema,
    tokens: z.object({ MaticToken: AddressSchema, PolToken: AddressSchema }),
    posBridge: z.object({
      RootChainManagerProxy: AddressSchema,
      ERC20PredicateProxy: AddressSchema,
      ERC721PredicateProxy: AddressSchema,
      ERC1155PredicateProxy: AddressSchema,
      MintableERC1155PredicateProxy: AddressSchema,
      EtherPredicateProxy: AddressSchema,
      DummyERC20: AddressSchema,
      DummyMintableERC20: AddressSchema,
      DummyERC721: AddressSchema,
      DummyMintableERC721: AddressSchema,
      DummyERC1155: AddressSchema,
      DummyMintableERC1155: AddressSchema
    })
  }),
  child: z.object({
    posBridge: z.object({
      DummyERC20: AddressSchema,
      DummyERC721: AddressSchema,
      DummyERC1155: AddressSchema,
      DummyMintableERC1155: AddressSchema,
      MaticWETH: AddressSchema
    })
  })
});

/**
 * What the tests receive: the SDK's `addresses:` override, the Dummy test
 * tokens on each chain, and the admin account that funds the test keys.
 * `scripts/up.ts` serialises this into `E2E_ADDRESSES_JSON`, and
 * `src/test-env.ts` parses it back with this same schema.
 */
export const DevnetContractsSchema = z.object({
  addresses: z.object({
    RootChainManager: AddressSchema,
    RootChain: AddressSchema,
    ERC20Predicate: AddressSchema,
    ERC721Predicate: AddressSchema,
    ERC1155Predicate: AddressSchema,
    EtherPredicate: AddressSchema,
    MintableERC1155Predicate: AddressSchema,
    StakeManager: AddressSchema,
    MaticToken: AddressSchema,
    PolToken: AddressSchema
  }),
  tokens: z.object({
    root: z.object({
      erc20: AddressSchema,
      mintableErc20: AddressSchema,
      erc721: AddressSchema,
      mintableErc721: AddressSchema,
      erc1155: AddressSchema,
      mintableErc1155: AddressSchema
    }),
    child: z.object({
      erc20: AddressSchema,
      erc721: AddressSchema,
      erc1155: AddressSchema,
      mintableErc1155: AddressSchema,
      maticWeth: AddressSchema
    })
  }),
  admin: z.object({ address: AddressSchema, privateKey: PrivateKeySchema })
});

export type DevnetContracts = z.infer<typeof DevnetContractsSchema>;

export interface Devnet extends DevnetContracts {
  l1RpcUrl: string;
  l2RpcUrl: string;
  heimdallRestUrl: string;
  l1ChainId: number;
  l2ChainId: number;
}

function kurtosisRaw(args: readonly string[]): string {
  try {
    return execFileSync(KURTOSIS, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    throw new VError('kurtosis command failed', {
      cause: err instanceof Error ? err : undefined,
      info: { args: args.join(' ') }
    });
  }
}

let engineChecked = false;

/** Run a kurtosis command, refusing to let it auto-start an engine. */
function kurtosis(args: readonly string[]): string {
  if (!engineChecked) {
    if (/No Kurtosis engine is running/i.test(kurtosisRaw(['engine', 'status']))) {
      throw new VError(
        `no kurtosis engine is running, so enclave '${ENCLAVE}' cannot be up. ` +
          'Start the devnet first (see packages/e2e/README.md).'
      );
    }
    engineChecked = true;
  }
  return kurtosisRaw(args);
}

/** Resolve a service name from `enclave inspect`, tolerating the optional `-archive` suffix. */
function resolveServiceName(inspectOutput: string, pattern: RegExp): string {
  const match = inspectOutput.match(pattern);
  if (!match) {
    throw new VError('no kurtosis service matched pattern', {
      info: { enclave: ENCLAVE, pattern: pattern.source }
    });
  }
  return match[0];
}

function toDevnetContracts(artifact: unknown): DevnetContracts {
  const { root, child } = ContractAddressesArtifactSchema.parse(artifact);
  return {
    addresses: {
      RootChainManager: root.posBridge.RootChainManagerProxy,
      RootChain: root.RootChainProxy,
      ERC20Predicate: root.posBridge.ERC20PredicateProxy,
      ERC721Predicate: root.posBridge.ERC721PredicateProxy,
      ERC1155Predicate: root.posBridge.ERC1155PredicateProxy,
      EtherPredicate: root.posBridge.EtherPredicateProxy,
      MintableERC1155Predicate: root.posBridge.MintableERC1155PredicateProxy,
      StakeManager: root.StakeManagerProxy,
      MaticToken: root.tokens.MaticToken,
      PolToken: root.tokens.PolToken
    },
    tokens: {
      root: {
        erc20: root.posBridge.DummyERC20,
        mintableErc20: root.posBridge.DummyMintableERC20,
        erc721: root.posBridge.DummyERC721,
        mintableErc721: root.posBridge.DummyMintableERC721,
        erc1155: root.posBridge.DummyERC1155,
        mintableErc1155: root.posBridge.DummyMintableERC1155
      },
      child: {
        erc20: child.posBridge.DummyERC20,
        erc721: child.posBridge.DummyERC721,
        erc1155: child.posBridge.DummyERC1155,
        mintableErc1155: child.posBridge.DummyMintableERC1155,
        maticWeth: child.posBridge.MaticWETH
      }
    },
    admin: {
      address: getAddress(DEVNET_ADMIN_ADDRESS),
      privateKey: DEVNET_ADMIN_PRIVATE_KEY
    }
  };
}

function parseJson(raw: string, source: string): unknown {
  // `kurtosis files inspect` prefixes the file with "File contents:".
  const start = raw.indexOf('{');
  if (start === -1) throw new VError('no JSON object found', { info: { source } });
  try {
    return JSON.parse(raw.slice(start));
  } catch (err) {
    throw new VError('could not parse devnet addresses JSON', {
      cause: err instanceof Error ? err : undefined,
      info: { source }
    });
  }
}

/**
 * What `scripts/down.ts` may remove: exactly the enclave (by UUID) or the
 * compose project that `scripts/up.ts` ran against. Nothing else.
 */
const TeardownRecordSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('kurtosis'), enclaveUuid: z.string().min(1) }),
  z.object({ mode: z.literal('snapshot'), composeFile: z.string().min(1) })
]);
export type TeardownRecord = z.infer<typeof TeardownRecordSchema>;

const TEARDOWN_RECORD_PATH = join(
  import.meta.dirname,
  '..',
  'node_modules',
  '.cache',
  'maticjs-e2e',
  'teardown.json'
);

export function writeTeardownRecord(record: TeardownRecord): void {
  mkdirSync(dirname(TEARDOWN_RECORD_PATH), { recursive: true });
  writeFileSync(TEARDOWN_RECORD_PATH, `${JSON.stringify(record)}\n`);
}

export function readTeardownRecord(): TeardownRecord | undefined {
  if (!existsSync(TEARDOWN_RECORD_PATH)) return undefined;
  return TeardownRecordSchema.parse(
    parseJson(readFileSync(TEARDOWN_RECORD_PATH, 'utf8'), TEARDOWN_RECORD_PATH)
  );
}

export function clearTeardownRecord(): void {
  rmSync(TEARDOWN_RECORD_PATH, { force: true });
}

/** Remove the kurtosis enclave with this UUID. Never starts an engine. */
export function removeEnclave(enclaveUuid: string): void {
  kurtosis(['enclave', 'rm', '-f', enclaveUuid]);
}

/** Read the running devnet and the record of what a later `down` may remove. */
export function readDevnet(): { devnet: Devnet; teardown: TeardownRecord } {
  const snapshotAddressesPath = process.env['E2E_SNAPSHOT_ADDRESSES_JSON'];
  if (snapshotAddressesPath) {
    return {
      devnet: {
        l1RpcUrl: SNAPSHOT_L1_RPC_URL,
        l2RpcUrl: SNAPSHOT_L2_RPC_URL,
        heimdallRestUrl: SNAPSHOT_HEIMDALL_REST_URL,
        l1ChainId: DEVNET_L1_CHAIN_ID,
        l2ChainId: DEVNET_L2_CHAIN_ID,
        ...toDevnetContracts(
          parseJson(readFileSync(snapshotAddressesPath, 'utf8'), snapshotAddressesPath)
        )
      },
      teardown: {
        mode: 'snapshot',
        composeFile: join(dirname(snapshotAddressesPath), 'docker-compose.yaml')
      }
    };
  }

  const inspect = kurtosis(['enclave', 'inspect', ENCLAVE]);
  const uuid = /^UUID:\s+(\S+)/m.exec(inspect)?.[1];
  if (!uuid || !/^Status:\s+RUNNING/m.test(inspect)) {
    throw new VError(`kurtosis enclave '${ENCLAVE}' is not running`);
  }
  const bor = resolveServiceName(inspect, /l2-el-\d+-bor-heimdall-v2-validator(-archive)?/);
  const heimdall = resolveServiceName(inspect, /l2-cl-\d+-heimdall-v2-bor-validator(-archive)?/);

  return {
    devnet: {
      l1RpcUrl: kurtosis(['port', 'print', ENCLAVE, 'anvil', 'rpc']),
      l2RpcUrl: kurtosis(['port', 'print', ENCLAVE, bor, 'rpc']),
      heimdallRestUrl: kurtosis(['port', 'print', ENCLAVE, heimdall, 'http']),
      l1ChainId: DEVNET_L1_CHAIN_ID,
      l2ChainId: DEVNET_L2_CHAIN_ID,
      ...toDevnetContracts(
        parseJson(
          kurtosis([
            'files',
            'inspect',
            ENCLAVE,
            'pos-contract-addresses',
            'contractAddresses.json'
          ]),
          'kurtosis pos-contract-addresses artifact'
        )
      )
    },
    teardown: { mode: 'kurtosis', enclaveUuid: uuid }
  };
}
