/**
 * Packed-tarball smoke test — verifies the artifact npm consumers
 * actually receive, not the workspace shape. This is the gate that the
 * go-live review found missing: every packaging defect it caught
 * (declaration files importing a devDep alias, exports conditions
 * pointing at files not in the tarball, a dist-less tarball, broken
 * subpath resolution) is invisible to unit tests and only reproduces
 * against the packed package installed into a clean consumer.
 *
 * Flow: build → `pnpm pack` → install the tarball into two throwaway
 * consumers (viem + ethers v6, and ethers v5 — separate consumers
 * because the two ethers majors can't coexist) → for each: import every
 * subpath at runtime, `require()` every subpath from a `.cjs` file
 * (the README promises native require of ES modules), verify
 * cross-entry `instanceof POSBridgeError` identity, and typecheck ESM
 * and CJS (`.cts`) probes with `skipLibCheck: false` so a broken
 * shipped declaration fails loudly (the ethers-v5 d.ts bug was silent
 * under the default `skipLibCheck: true`).
 *
 * Run locally: `pnpm run test:pack` (from packages/maticjs). CI runs it
 * in the build matrix on every PR — hence plain JavaScript: the matrix
 * includes Node 20, which cannot execute TypeScript natively.
 */
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(join(tmpdir(), 'maticjs-pack-smoke-'));

const run = (cmd, cwd) => {
  return execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
};

// require() of ES modules: unflagged on Node >= 20.19, >= 22.12 and 23+;
// Node 22.0-22.11 has it behind --experimental-require-module (the
// README documents that caveat, so the probe exercises it with the
// flag). Older lines (20.0-20.18, 21) are outside the documented
// support for require(), so the probe skips there LOUDLY rather than
// failing. CI's 20.x/22.x/24.x matrix resolves to current releases,
// all of which take the unflagged path.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const requireEsmFlag =
  (nodeMajor === 20 && nodeMinor >= 19) || (nodeMajor === 22 && nodeMinor >= 12) || nodeMajor >= 23
    ? ''
    : nodeMajor === 22
      ? '--experimental-require-module '
      : null;

// Run from a .cjs file so the consumer's `"type": "module"` can't turn
// the probe into ESM: this is exactly what a CommonJS caller executes.
const requireProbe = `
const [spec, exportName] = process.argv.slice(2);
const mod = require(spec);
if (mod[exportName] === undefined) throw new Error(spec + ' has no export ' + exportName);
console.log('ok');
`;

let failed = false;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failed = true;
};
const ok = (msg) => {
  console.log(`✓ ${msg}`);
};

try {
  // 1. Build + pack.
  run('pnpm run build', pkgDir);
  const tarball = join(work, 'maticjs.tgz');
  run(`pnpm pack --out ${tarball}`, pkgDir);
  ok('built and packed');

  const consumers = [
    {
      name: 'viem+ethers6',
      installs: ['viem@^2', 'ethers@^6'],
      imports: [
        '@polygonlabs/maticjs',
        '@polygonlabs/maticjs/abi',
        '@polygonlabs/maticjs/viem',
        '@polygonlabs/maticjs/ethers-v6'
      ],
      // spec → an export that must exist on the require()d namespace.
      requires: {
        '@polygonlabs/maticjs': 'POSClient',
        '@polygonlabs/maticjs/abi': 'RootChainManagerABI',
        '@polygonlabs/maticjs/viem': 'viemAdapter',
        '@polygonlabs/maticjs/ethers-v6': 'ethersV6Adapter'
      },
      probe: `
import { POSClient, POSBridgeError } from '@polygonlabs/maticjs';
import type { POSClientConfig, TxResult } from '@polygonlabs/maticjs';
import { viemAdapter } from '@polygonlabs/maticjs/viem';
import { ethersV6Adapter } from '@polygonlabs/maticjs/ethers-v6';
import { RootChainManagerABI } from '@polygonlabs/maticjs/abi';
// Types must be real (not any): assigning a wrong shape must fail.
// @ts-expect-error — viemAdapter requires a config object, not a number
const bad = viemAdapter(42);
const abiIsTyped: typeof RootChainManagerABI extends readonly unknown[] ? true : never = true;
console.log(typeof POSClient, typeof POSBridgeError, typeof ethersV6Adapter, Boolean(bad), abiIsTyped);
export type { POSClientConfig, TxResult };
`
    },
    {
      name: 'ethers5',
      installs: ['ethers@^5.8.0'],
      imports: ['@polygonlabs/maticjs', '@polygonlabs/maticjs/ethers-v5'],
      requires: {
        '@polygonlabs/maticjs': 'POSClient',
        '@polygonlabs/maticjs/ethers-v5': 'ethersV5Adapter'
      },
      probe: `
import { providers, Wallet } from 'ethers';
import { ethersV5Adapter } from '@polygonlabs/maticjs/ethers-v5';
// The shipped d.ts must resolve its 'ethers' import against the
// CONSUMER'S ethers v5 — if it still references the internal
// 'ethers-v5' alias, this file fails to typecheck (skipLibCheck off).
const provider = new providers.JsonRpcProvider('http://127.0.0.1:1');
const signer = Wallet.createRandom().connect(provider);
const adapter = ethersV5Adapter({ provider, signer });
// @ts-expect-error — adapter config requires a provider, not a string
const bad = ethersV5Adapter({ provider: 'nope' });
console.log(Boolean(adapter), Boolean(bad));
`
    }
  ];

  for (const consumer of consumers) {
    const dir = join(work, consumer.name);
    run(`mkdir -p ${dir}`, work);
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify(
        { name: `smoke-${consumer.name}`, private: true, type: 'module', version: '0.0.0' },
        null,
        2
      )
    );
    // npm (not pnpm): plainest consumer install shape, no workspace magic.
    run(
      `npm install --no-audit --no-fund ${tarball} ${consumer.installs.join(' ')} typescript@^5 @types/node@^20`,
      dir
    );
    ok(`${consumer.name}: installed from tarball`);

    for (const spec of consumer.imports) {
      try {
        run(`node --input-type=module -e "await import('${spec}'); console.log('ok')"`, dir);
        ok(`${consumer.name}: runtime import ${spec}`);
      } catch {
        fail(`${consumer.name}: runtime import FAILED for ${spec}`);
      }
    }

    if (requireEsmFlag === null) {
      console.warn(
        `! ${consumer.name}: require() probe SKIPPED — Node ${process.versions.node} predates require() of ES modules`
      );
    } else {
      writeFileSync(join(dir, 'require-probe.cjs'), requireProbe);
      for (const [spec, exportName] of Object.entries(consumer.requires)) {
        try {
          run(`node ${requireEsmFlag}require-probe.cjs ${spec} ${exportName}`, dir);
          ok(`${consumer.name}: require() ${spec}`);
        } catch {
          fail(`${consumer.name}: require() FAILED for ${spec}`);
        }
      }
    }

    // Cross-entry instanceof identity (chunk-duplication regression guard).
    if (consumer.name === 'viem+ethers6') {
      try {
        run(
          `node --input-type=module -e "` +
            `import { POSBridgeError } from '@polygonlabs/maticjs';` +
            `const err = new POSBridgeError('PROOF_API_NOT_SET', 'x');` +
            `if (!(err instanceof POSBridgeError)) throw new Error('identity');` +
            `if (err.type !== 'proof_api_not_set') throw new Error('legacy type');` +
            `console.log('ok')"`,
          dir
        );
        ok(`${consumer.name}: POSBridgeError identity + legacy type`);
      } catch {
        fail(`${consumer.name}: POSBridgeError identity check FAILED`);
      }
    }

    writeFileSync(join(dir, 'probe.ts'), consumer.probe);
    // CommonJS-side twin: a .cts whose imports compile to require(), so
    // the shipped declarations must also resolve for CJS consumers.
    const cjsNames = Object.entries(consumer.requires);
    writeFileSync(
      join(dir, 'probe-cjs.cts'),
      cjsNames.map(([spec, name]) => `import { ${name} } from '${spec}';`).join('\n') +
        `\nconsole.log(${cjsNames.map(([, name]) => name).join(', ')});\n`
    );
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2023',
            strict: true,
            noEmit: true,
            // Deliberately OFF: a broken shipped .d.ts must FAIL here.
            skipLibCheck: false
          },
          include: ['probe.ts', 'probe-cjs.cts']
        },
        null,
        2
      )
    );
    try {
      run('npx tsc -p tsconfig.json', dir);
      ok(`${consumer.name}: ESM + CJS probes typecheck with skipLibCheck:false`);
    } catch {
      fail(`${consumer.name}: probe typecheck FAILED (broken shipped declarations?)`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failed) {
  console.error('pack-smoke: FAILED');
  process.exit(1);
}
console.log('pack-smoke: all checks passed');
