/**
 * Playwright config for the @polygonlabs/pos-sdk browser smoke test.
 *
 * # Why a single chromium project, not cross-browser
 *
 * The smoke test only needs to verify that the SDK's bundled output
 * loads and runs in *a* real browser without polyfill errors. Adding
 * firefox / webkit projects multiplies the install footprint without
 * surfacing any new bundling failure mode — the polyfill story is the
 * same in
 * all three engines (and the same as Vite's `build.target: es2023`
 * output assumes). When we add cross-browser concerns later, we add
 * additional projects here.
 *
 * # webServer
 *
 * `vite preview` serves the production build (the result of
 * `vite build`), not the dev server. That is deliberate: we want to
 * test the **bundled** SDK output, not Vite's dev-mode on-the-fly
 * compilation. The dev server hides bundling defects that only show
 * up after Rollup processes the SDK source.
 */

import { defineConfig } from '@playwright/test';

const PREVIEW_PORT = 4173;

export default defineConfig({
  testDir: './tests',
  // Single worker — there is one Vite preview server, and the tests
  // share a single page state. Parallelism would not buy anything.
  workers: 1,
  // Retries hide flakes; we want every failure to surface immediately.
  retries: 0,
  reporter: process.env.CI === 'true' ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PREVIEW_PORT}`,
    // Trace on first retry would be useless with retries: 0; capture
    // on failure so a CI failure reproduces locally without rerunning.
    trace: 'retain-on-failure'
  },
  webServer: {
    // `vite preview --port <n>` serves the result of `vite build`.
    // `pnpm exec` resolves vite from the workspace root via
    // hoisted-pnpm.
    command: `pnpm exec vite preview --port ${PREVIEW_PORT} --host 127.0.0.1 --strictPort`,
    url: `http://127.0.0.1:${PREVIEW_PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe'
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' }
    }
  ]
});
