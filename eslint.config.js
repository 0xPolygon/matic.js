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
    files: ['packages/pos-sdk/src/**/*.ts'],
    ignores: ['packages/pos-sdk/src/adapters/**'],
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
    ignores: [
      '**/dist/**',
      // standalone consumer-facing reference scripts, not part of the workspace
      'examples/**',
      // manual developer scratch scripts — not automated, not part of the workspace
      'manual/**'
    ]
  }
]);
