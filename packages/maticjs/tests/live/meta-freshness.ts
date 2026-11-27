import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * Tells "the CDN index moved and `@polygonlabs/meta` has not been bumped
 * here yet" apart from "the CDN is serving something unexpected".
 *
 * `0xPolygon/static` deploys the production index and publishes
 * `@polygonlabs/meta` from the same tag, so a newer meta on npm than the
 * installed one is the fingerprint of the first case. The live-CDN test
 * tolerates a mismatch only under that fingerprint.
 */

export type IndexMismatchKind = 'bump-pending' | 'unexpected';

const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@polygonlabs/meta/latest';
const REGISTRY_TIMEOUT_MS = 10_000;

function parseStable(version: string): [number, number, number] | undefined {
  const match = STABLE_VERSION.exec(version);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Fails closed: anything that is not clearly "latest is a newer stable
 * release" is `'unexpected'`, so a registry oddity can never silence a
 * real CDN fault. Compared numerically; `1.10.0` is newer than `1.2.0`.
 */
export function classifyIndexMismatch({
  installed,
  latest
}: {
  installed: string;
  latest: string;
}): IndexMismatchKind {
  const installedParts = parseStable(installed);
  const latestParts = parseStable(latest);
  if (!installedParts || !latestParts) return 'unexpected';
  for (let i = 0; i < 3; i++) {
    const a = latestParts[i] ?? 0;
    const b = installedParts[i] ?? 0;
    if (a > b) return 'bump-pending';
    if (a < b) return 'unexpected';
  }
  return 'unexpected';
}

/**
 * Meta's `exports` map does not expose `./package.json`, and vitest's
 * module runner does not implement `import.meta.resolve`, so read the
 * manifest by path from the first `node_modules` lookup location that
 * holds the package (the same search Node's resolver performs).
 */
export function installedMetaVersion(): string {
  const searchDirs = createRequire(import.meta.url).resolve.paths('@polygonlabs/meta') ?? [];
  for (const dir of searchDirs) {
    let raw: string;
    try {
      raw = readFileSync(join(dir, '@polygonlabs', 'meta', 'package.json'), 'utf8');
    } catch {
      continue;
    }
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
    throw new Error(`installed @polygonlabs/meta manifest in ${dir} has no string version`);
  }
  throw new Error('could not locate the installed @polygonlabs/meta package');
}

/** Any non-200, timeout or malformed body throws, so a test cannot pass on a guess. */
export async function fetchLatestMetaVersion(): Promise<string> {
  const response = await fetch(REGISTRY_LATEST_URL, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS)
  });
  if (response.status !== 200) {
    throw new Error(`npm registry returned HTTP ${response.status} for ${REGISTRY_LATEST_URL}`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    !('version' in body) ||
    typeof body.version !== 'string'
  ) {
    throw new Error(`npm registry body for ${REGISTRY_LATEST_URL} has no string "version"`);
  }
  return body.version;
}
