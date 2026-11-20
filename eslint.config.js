import { defineConfig } from 'eslint/config';

import { recommended, typescript } from '@polygonlabs/apps-team-lint';

// Extract the @typescript-eslint plugin from the typescript() configs so we can
// reference it in our override without adding a separate direct dependency.
const tsConfigs = typescript();
const tsPluginConfig = tsConfigs.find((c) => c.plugins?.['@typescript-eslint']);
const tsPlugin = tsPluginConfig?.plugins?.['@typescript-eslint'];

export default defineConfig([
  ...recommended({ globals: 'node' }),
  ...tsConfigs,
  {
    // Standard convention: parameters prefixed with _ are intentionally unused.
    // Used in stub implementations during the 1.0 rewrite migration window.
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  },
  {
    // Ban the `as unknown as X` double-assertion — the escape hatch that
    // fully overrides the type checker — everywhere in the published SDK
    // source EXCEPT the adapter boundary. `: any` / `as any` are already
    // banned globally by the preset's no-explicit-any; this closes the
    // remaining "lie to the compiler" pattern.
    //
    // The carve-out below (`src/adapters/**`) is the single sanctioned
    // home for these casts: viem / ethers v5 / ethers v6 have type shapes
    // the SDK's own interfaces can't express without impedance casts at
    // the call boundary, exactly the "isolate the third-party cast in a
    // helper at the boundary" allowance in team-standards. Everywhere
    // else, fix the upstream type instead of asserting through `unknown`.
    files: ['packages/maticjs/src/**/*.ts'],
    ignores: ['packages/maticjs/src/adapters/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSUnknownKeyword',
          message:
            'Double type-assertion (`as unknown as X`) bypasses the type checker. It is only permitted in src/adapters/** at the viem/ethers boundary; elsewhere, fix the upstream type.'
        }
      ]
    }
  },
  {
    // Ban the ABI barrel everywhere in the SDK source but the barrel's own
    // directory: a shared module (the PoS client, a service, an adapter) is
    // reached by several entries, so a barrel import there leaks the same way
    // as one inside an entry's own tree. The barrel
    // (`src/abi/index.ts`) re-exports every ABI, so importing one ABI through
    // it merges the bridge and staking ABI closures into one chunk (and
    // `src/abi/plasma/index.ts` does the same for the Plasma ABIs).
    // esbuild tree-shakes the unused arrays from the output, so build, the
    // isolation gate and unit tests all pass while the source import is wrong;
    // only a lint rule on the import itself catches it.
    //
    // A regex, not a gitignore-style `group`: `**/abi` would also match each
    // per-module import (`../abi/ChildERC20.js`), which is the form we want.
    files: ['packages/maticjs/src/**/*.ts'],
    ignores: ['packages/maticjs/src/abi/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(\\.\\.?/)+abi(/index(\\.[jt]s)?)?/?$',
              message:
                "Import each ABI from its own module (e.g. '../abi/ChildERC20.js'), never the ABI barrel: the barrel merges the bridge and staking ABI closures, so entries would load ABIs they do not use. scripts/check-entry-isolation.mjs cannot see this because the bundler tree-shakes the unused arrays."
            },
            {
              // Same rule for the Plasma barrel (`src/abi/plasma/index.ts`),
              // which re-exports every Plasma ABI.
              regex: '^(\\.\\.?/)+abi/plasma(/index(\\.[jt]s)?)?/?$',
              message:
                "Import each Plasma ABI from its own module (e.g. '../abi/plasma/DepositManager.js'), never the Plasma ABI barrel: the barrel merges every Plasma ABI, so an entry would load Plasma ABIs it does not use. scripts/check-entry-isolation.mjs cannot see this because the bundler tree-shakes the unused arrays."
            }
          ]
        }
      ]
    }
  },
  {
    ignores: [
      '**/dist/**',
      // standalone consumer-facing reference scripts, not part of the workspace
      'examples/**',
      // manual developer scratch scripts — not automated, not part of the workspace
      'manual/**',
      // verbatim third-party source, see packages/maticjs/THIRD_PARTY_NOTICES.md
      'packages/maticjs/src/vendor/**'
    ]
  }
]);
