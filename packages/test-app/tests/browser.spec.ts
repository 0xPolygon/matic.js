/**
 * Playwright spec for the @polygonlabs/pos-sdk browser smoke test.
 *
 * The test loads `/`, waits for `#result` to flip from `pending` to a
 * JSON blob, then asserts on every field. It also captures every
 * `console.error` and fails if any fired during the run — that is how
 * a `Buffer is not defined` ReferenceError surfaces.
 *
 * # Skip when Playwright browsers aren't installed
 *
 * `pnpm -r run test` from the workspace root runs this spec. CI
 * installs the browser explicitly via
 * `pnpm exec playwright install chromium --with-deps`; on a fresh
 * developer machine — or after a Playwright version bump that expects
 * a newer browser revision — the binary may be absent. Rather than
 * failing with a cryptic "Executable doesn't exist", we PROBE by
 * actually launching the browser once in `beforeAll` and skip the
 * suite if the launch throws. A static `existsSync(executablePath())`
 * check is not enough: headless runs use a separate
 * `chrome-headless-shell` binary, so the full-chromium path can exist
 * while the binary the launch actually needs is missing. Only a real
 * launch attempt detects both cases.
 */

import { chromium, expect, test } from '@playwright/test';

let browserLaunchable = false;

test.beforeAll(async () => {
  try {
    const browser = await chromium.launch();
    await browser.close();
    browserLaunchable = true;
  } catch {
    // Binary (full chromium or chrome-headless-shell) is absent; the
    // suite skips with the remediation message in beforeEach.
    browserLaunchable = false;
  }
});

test.describe('SDK browser smoke test', () => {
  test.beforeEach(() => {
    test.skip(
      !browserLaunchable,
      'skipped: install Playwright browsers via `pnpm exec playwright install --with-deps chromium`'
    );
  });

  test('the bundled SDK loads cleanly and every public symbol works', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`pageerror: ${err.message}`);
    });

    const response = await page.goto('/');
    expect(response, 'page.goto returned no response').not.toBeNull();
    expect(response?.ok(), `unexpected status ${String(response?.status())}`).toBe(true);

    // Wait for the smoke harness to flip data-state away from
    // `pending`. Either `ready` (everything passed) or `failed` (the
    // page wrote diagnostics into the blob — we assert below).
    const resultLocator = page.locator('#result');
    await expect(resultLocator).toHaveAttribute('data-state', /ready|failed/, { timeout: 30_000 });

    const text = await resultLocator.textContent();
    expect(text, 'smoke harness did not write a result blob').toBeTruthy();

    // Narrow the parsed payload at the boundary; nothing crosses into
    // assertion code as `any`.
    const parsed: unknown = JSON.parse(text ?? '');
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`expected object result, got ${typeof parsed}`);
    }
    const result = parsed as Record<string, unknown>;

    expect(result.errors, `smoke errors: ${JSON.stringify(result.errors)}`).toEqual([]);
    expect(result.posClientReady, 'POSClient.init failed').toBe(true);

    expect(typeof result.prepareApproveData, 'prepareApproveData is not a string').toBe('string');
    expect(result.prepareApproveData as string).toMatch(/^0x[0-9a-f]+$/);
    expect((result.prepareApproveData as string).length).toBeGreaterThan(10);

    expect(result.posBridgeErrorCode).toBe('BURN_TX_NOT_CHECKPOINTED');
    expect(result.posBridgeErrorInfo).toEqual({ txHash: '0xdead', blockNumber: 42 });
    expect(result.posBridgeErrorCauseMessage).toContain('upstream RPC 500');

    expect(result.sanitisedMessage).toBe(
      'failed at https://rpc.example/api?token=***&foo=bar'
    );

    expect(result.keccakOk, 'keccak256 produced an unexpected digest').toBe(true);
    expect(result.noopLoggerOk, 'noopLogger threw').toBe(true);
    expect(result.addressFetcherOk, 'createAddressFetcher override path failed').toBe(true);

    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toEqual([]);
  });
});
