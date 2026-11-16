import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * The static half of the error-ownership rule (AGENTS.md, "Error ownership
 * (mandatory)"): `scripts/check-error-ownership.mjs` must pass over `src`.
 * Running it here puts it in CI with no workflow of its own. The runtime
 * half is the identity falsification tests (`falsification-*.test.ts`).
 *
 * The reviewed `cause` sites live in the script's ALLOWED_CAUSE_SITES and
 * nowhere else. The falsification rows below plant each violation the gate
 * exists for in a copy of `src` and require it to fail, so a gate that has
 * quietly stopped matching anything cannot stay green.
 */

const PACKAGE = join(import.meta.dirname, '..', '..');
const SRC = join(PACKAGE, 'src');
const GATE = join(PACKAGE, 'scripts', 'check-error-ownership.mjs');

const runGate = (srcDir: string): { status: number | null; output: string } => {
  const run = spawnSync(process.execPath, [GATE, srcDir], { encoding: 'utf8' });
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
};

const copies: string[] = [];
afterAll(() => {
  for (const dir of copies) rmSync(dir, { recursive: true, force: true });
});

/** A copy of `src` with `edit` applied to one file. */
const plant = ({ file, edit }: { file: string; edit: (source: string) => string }): string => {
  const dir = mkdtempSync(join(tmpdir(), 'maticjs-error-ownership-'));
  copies.push(dir);
  cpSync(SRC, dir, { recursive: true });
  const path = join(dir, file);
  const before = readFileSync(path, 'utf8');
  const after = edit(before);
  if (after === before) throw new Error(`plant: the edit to ${file} changed nothing`);
  writeFileSync(path, after);
  return dir;
};

const replaceOnce = ({
  source,
  find,
  replace
}: {
  source: string;
  find: string;
  replace: string;
}): string => {
  if (source.split(find).length !== 2) throw new Error(`plant: expected one "${find}"`);
  return source.replace(find, replace);
};

// Each row spawns Node; under a full parallel run that can exceed the default 5 s.
describe('error ownership gate', { timeout: 30_000 }, () => {
  it('passes over src', () => {
    const { status, output } = runGate(SRC);

    expect(status, output).equals(0);
  });

  it('fails a cause: err in an adapter catch that checks isError(err, CALL_EXCEPTION)', () => {
    const dir = plant({
      file: 'adapters/ethers-v6.ts',
      edit: (source) =>
        `${source}
export const planted = async (run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (err) {
    if (isError(err, 'CALL_EXCEPTION')) throw new VError('reverted', { cause: err });
    throw err;
  }
};
`
    });

    const { status, output } = runGate(dir);

    expect(status).equals(1);
    expect(output).contains('src/adapters/ethers-v6.ts:').contains('(a) cause set in a catch');
  });

  it('fails a cause on a library error in a wait() rejection handler', () => {
    const dir = plant({
      file: 'adapters/ethers-v6.ts',
      edit: (source) =>
        replaceOnce({
          source,
          find: `if (isError(err, 'CALL_EXCEPTION') && err.receipt?.status === 0) {
              return { libraryRejection: err };`,
          replace: `if (isError(err, 'CALL_EXCEPTION') && err.receipt?.status === 0) {
              throw new VError('reverted', { cause: err });`
        })
    });

    const { status, output } = runGate(dir);

    expect(status).equals(1);
    expect(output).contains('(a) cause set in a .then() rejection handler');
  });

  it('fails a catch that mints TransactionRevertedError from isCallException, even without a cause', () => {
    const dir = plant({
      file: 'internal/confirmation.ts',
      edit: (source) =>
        `${source}
export const planted = async (run: () => Promise<void>): Promise<void> => {
  try {
    await run();
  } catch (err) {
    if (isCallException(err)) throw new TransactionRevertedError('reverted', { info: {} });
    throw err;
  }
};
`
    });

    const { status, output } = runGate(dir);

    expect(status).equals(1);
    expect(output)
      .contains('src/internal/confirmation.ts:')
      .contains('(b) TransactionRevertedError built in a catch');
  });

  it('fails a cause site that is not in the allowlist', () => {
    const dir = plant({
      file: 'internal/confirmation.ts',
      edit: (source) =>
        `${source}
export const planted = (err: Error): Error => new Error('planted', { cause: err });
`
    });

    const { status, output } = runGate(dir);

    expect(status).equals(1);
    expect(output).contains('(c) cause site not in ALLOWED_CAUSE_SITES');
  });
});
