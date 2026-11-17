import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { classifyIndexMismatch, installedMetaVersion } from '../live/meta-freshness.ts';

describe('classifyIndexMismatch', () => {
  it('treats a newer stable latest as a pending bump', () => {
    expect(classifyIndexMismatch({ installed: '1.1.1', latest: '1.2.0' })).equals('bump-pending');
  });

  it('compares numerically, not as strings', () => {
    expect(classifyIndexMismatch({ installed: '1.2.0', latest: '1.10.0' })).equals('bump-pending');
  });

  it('detects a newer major', () => {
    expect(classifyIndexMismatch({ installed: '1.9.9', latest: '2.0.0' })).equals('bump-pending');
  });

  it('fails closed when versions are equal', () => {
    expect(classifyIndexMismatch({ installed: '1.2.0', latest: '1.2.0' })).equals('unexpected');
  });

  it('fails closed when latest is older than installed', () => {
    expect(classifyIndexMismatch({ installed: '1.2.0', latest: '1.1.9' })).equals('unexpected');
  });

  it('fails closed on a prerelease latest', () => {
    expect(classifyIndexMismatch({ installed: '1.2.0', latest: '1.3.0-dev.1' })).equals(
      'unexpected'
    );
  });

  it('fails closed on an empty latest', () => {
    expect(classifyIndexMismatch({ installed: '1.2.0', latest: '' })).equals('unexpected');
  });

  it('fails closed on a non-version latest', () => {
    expect(classifyIndexMismatch({ installed: '1.2.0', latest: 'latest' })).equals('unexpected');
  });

  it('fails closed on an unparseable installed version', () => {
    expect(classifyIndexMismatch({ installed: '', latest: '1.2.0' })).equals('unexpected');
  });
});

describe('installedMetaVersion', () => {
  it('returns the version pinned in pnpm-lock.yaml', () => {
    const version = installedMetaVersion();
    expect(version).match(/^\d+\.\d+\.\d+$/);

    // Tests sit at packages/maticjs/tests/unit; the lockfile is at the repo root.
    const lockfile = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'pnpm-lock.yaml'),
      'utf8'
    );
    const pinned = /^ {2}'@polygonlabs\/meta@(\d+\.\d+\.\d+)':/m.exec(lockfile)?.[1];
    expect(version).equals(pinned);
  });
});
