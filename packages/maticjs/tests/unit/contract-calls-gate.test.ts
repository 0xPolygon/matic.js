import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The static half of the contract-call rule (AGENTS.md, "Contract calls are
 * typed against the ABI (mandatory)"): `scripts/check-contract-calls.mjs` must
 * pass over `src`. Running it here puts it in CI with no workflow of its own.
 * The compiler half is `contract-caller-types.test.ts`.
 *
 * The gate's allowlist lives in the script and nowhere else. The rows below
 * feed it a small program that breaks each rule once and require the matching
 * finding, so a gate that has quietly stopped matching anything cannot stay
 * green.
 */

const PACKAGE = join(import.meta.dirname, '..', '..');
const GATE = join(PACKAGE, 'scripts', 'check-contract-calls.mjs');

interface Violation {
  rule: number;
  file: string;
  line: number;
  message: string;
}
interface AllowlistEntry {
  rule: number;
  file: string;
  code: string;
  reason: string;
}
interface Gate {
  ALLOWLIST: readonly AllowlistEntry[];
  checkSources: (params: {
    files: Record<string, string>;
    allowlist?: readonly AllowlistEntry[];
  }) => { violations: Violation[]; counts: { callerCalls: number; adapterReads: number } };
}

const gate: Gate = await import(pathToFileURL(GATE).href);

/** The two declarations the gate recognises by file and name, reduced to what a call needs. */
const STUBS = {
  'adapter.ts': `
export interface Adapter {
  read(req: { functionName: string }): Promise<unknown>;
}
`,
  'internal/contract-caller.ts': `
import type { Adapter } from '../adapter.js';
export interface WriteCall { method: string; args: readonly unknown[] }
type Name = 'balanceOf' | 'approve' | 'exists' | 'a' | 'b';
export class ContractCaller<TAbi = unknown> {
  declare readonly abi?: TAbi;
  constructor(private readonly adapter: Adapter) {}
  read(method: Name, args: readonly unknown[]): Promise<unknown>;
  async read(method: string, _args: readonly unknown[]): Promise<unknown> {
    return this.adapter.read({ functionName: method });
  }
  write(call: Name | WriteCall, args?: readonly unknown[]): Promise<unknown>;
  async write(call: string | WriteCall, _args?: readonly unknown[]): Promise<unknown> {
    return call;
  }
  prepareWrite(call: Name | WriteCall, args?: readonly unknown[]): Promise<unknown>;
  async prepareWrite(call: string | WriteCall, _args?: readonly unknown[]): Promise<unknown> {
    return call;
  }
  estimateGas(call: Name | WriteCall, args?: readonly unknown[]): Promise<unknown>;
  async estimateGas(call: string | WriteCall, _args?: readonly unknown[]): Promise<unknown> {
    return call;
  }
}
`
};

const run = ({
  files,
  allowlist
}: {
  files: Record<string, string>;
  allowlist?: readonly AllowlistEntry[];
}): ReturnType<Gate['checkSources']> =>
  gate.checkSources({ files: { ...STUBS, ...files }, ...(allowlist ? { allowlist } : {}) });

const CLEAN = `
import type { Adapter } from '../adapter.js';
import { ContractCaller } from '../internal/contract-caller.js';
import type { WriteCall } from '../internal/contract-caller.js';

export class Handle {
  readonly #caller: ContractCaller;
  constructor(adapter: Adapter) {
    this.#caller = new ContractCaller(adapter);
  }
  read() {
    return this.#caller.read('balanceOf', []);
  }
  byDescriptor(call: WriteCall) {
    return this.#caller.write(call);
  }
  literalDescriptor() {
    return this.#caller.prepareWrite({ method: 'approve', args: [] });
  }
  forward<N extends 'approve' | 'transfer'>(method: N) {
    return this.#caller.write(method, []);
  }
}
`;

// Each row builds a TypeScript program; under a full parallel run that can exceed the default 5 s.
describe('contract-calls gate', { timeout: 30_000 }, () => {
  it('passes over src', () => {
    const run = spawnSync(process.execPath, [GATE], { encoding: 'utf8' });

    expect(run.status, `${run.stdout}${run.stderr}`).equals(0);
    expect(run.stdout).match(/\d+ ContractCaller calls and \d+ Adapter\.read calls checked/);
  });

  it('keeps an empty allowlist', () => {
    expect(gate.ALLOWLIST).lengthOf(0);
  });

  it('accepts literals, descriptors, forwarded names and a #caller field', () => {
    const { violations, counts } = run({
      files: {
        'pos/clean.ts': CLEAN,
        'adapters/own.ts': `
import type { Adapter } from '../adapter.js';
export const readOwn = (adapter: Adapter) => adapter.read({ functionName: 'x' });
`
      }
    });

    expect(violations).deep.equal([]);
    expect(counts.callerCalls).equals(4);
  });

  it('fails an Adapter.read outside the caller and the adapters', () => {
    const { violations } = run({
      files: {
        'pos/direct.ts': `
import type { Adapter } from '../adapter.js';
export const readDirect = (adapter: Adapter) => adapter.read({ functionName: 'exists' });
`
      }
    });

    expect(violations).lengthOf(1);
    expect(violations[0]).property('rule', 1);
    expect(violations[0]).property('file', 'pos/direct.ts');
  });

  it('fails a method name held in a string, a literal-union or a const variable', () => {
    const { violations } = run({
      files: {
        'pos/dynamic.ts': `
import type { ContractCaller } from '../internal/contract-caller.js';
export const viaString = (caller: ContractCaller, name: string) => caller.read(name, []);
export const viaUnion = (caller: ContractCaller, name: 'a' | 'b') => caller.write(name, []);
const picked = 'approve';
export const viaConst = (caller: ContractCaller) => caller.estimateGas(picked, []);
`
      }
    });

    expect(violations.map((v) => v.rule)).deep.equal([2, 2, 2]);
  });

  it('fails an @internal marker on a public member', () => {
    const { violations } = run({
      files: {
        'pos/marked.ts': `
export class Marked {
  /** @internal */
  readonly wiring = 1;
}
`
      }
    });

    expect(violations).lengthOf(1);
    expect(violations[0]).property('rule', 3);
    expect(violations[0]).property('line', 3);
  });

  it('fails a caller member that is not a #caller field', () => {
    const { violations } = run({
      files: {
        'pos/members.ts': `
import type { ContractCaller } from '../internal/contract-caller.js';
export class Public { readonly caller!: ContractCaller; }
export class TsPrivate { private readonly caller!: ContractCaller; }
export class ParameterProperty { constructor(private readonly caller: ContractCaller) {} }
export class Accessor { get caller(): number { return 1; } }
export interface Config { caller?: ContractCaller }
export const wiring = (caller: ContractCaller) => ({ caller });
`
      }
    });

    expect(violations.map((v) => v.rule)).deep.equal([4, 4, 4, 4]);
  });

  it('fails any class member that holds a ContractCaller and is not #private, whatever its name', () => {
    const { violations } = run({
      files: {
        'pos/holders.ts': `
import type { Adapter } from '../adapter.js';
import { ContractCaller } from '../internal/contract-caller.js';
export class TsPrivate { private readonly helperCaller!: ContractCaller<readonly string[]>; }
export class Public { readonly helper!: ContractCaller<readonly string[]>; }
export class Optional { private readonly maybe: ContractCaller<readonly string[]> | undefined; }
export class ParameterProperty { constructor(private readonly via: ContractCaller<readonly string[]>) {} }
export class Inferred { private readonly built = new ContractCaller(null as unknown as Adapter); }
`
      }
    });

    expect(violations.map((v) => [v.rule, v.line])).deep.equal([
      [4, 4],
      [4, 5],
      [4, 6],
      [4, 7],
      [4, 8]
    ]);
  });

  it('accepts a #private ContractCaller member and callers that are not class members', () => {
    const { violations } = run({
      files: {
        'pos/fine.ts': `
import { ContractCaller } from '../internal/contract-caller.js';
export class Hidden {
  readonly #helper: ContractCaller<readonly string[]>;
  readonly #optional: ContractCaller<readonly string[]> | undefined;
  constructor(helper: ContractCaller<readonly string[]>) {
    this.#helper = helper;
    this.#optional = undefined;
  }
  use(): unknown { return [this.#helper, this.#optional]; }
  build(helper: ContractCaller): ContractCaller { return helper; }
}
export interface Config { helperCaller: ContractCaller<readonly string[]> }
export const wiring = (helperCaller: ContractCaller) => ({ helperCaller });
`
      }
    });

    expect(violations).deep.equal([]);
  });

  it('fails a public ContractCaller signature whose method parameter is typed string', () => {
    const { violations } = run({
      files: {
        'internal/contract-caller.ts': `
import type { Adapter } from '../adapter.js';
export interface WriteCall { method: string; args: readonly unknown[] }
type Name = 'balanceOf' | 'approve';
export class ContractCaller<TAbi = unknown> {
  declare readonly abi?: TAbi;
  constructor(private readonly adapter: Adapter) {}
  read(method: Name, args: readonly unknown[]): Promise<unknown>;
  read<T>(method: string, args: readonly unknown[]): Promise<T>;
  async read(method: string, _args: readonly unknown[]): Promise<unknown> {
    return this.adapter.read({ functionName: method });
  }
  write<N extends string>(call: N, args?: readonly unknown[]): Promise<unknown>;
  write(call: Name | WriteCall, args?: readonly unknown[]): Promise<unknown>;
  async write(call: string | WriteCall, _args?: readonly unknown[]): Promise<unknown> {
    return call;
  }
  prepareWrite(call: string | WriteCall, _args?: readonly unknown[]): Promise<unknown> {
    return Promise.resolve(call);
  }
  estimateGas(call: Name | WriteCall, args?: readonly unknown[]): Promise<unknown>;
  async estimateGas(call: string | WriteCall, _args?: readonly unknown[]): Promise<unknown> {
    return call;
  }
}
`
      }
    });

    expect(violations.map((v) => [v.rule, v.line])).deep.equal([
      [5, 9],
      [5, 13],
      [5, 18]
    ]);
  });

  it('lets a reviewed allowlist entry through, and fails an entry that matches nothing', () => {
    const files = {
      'pos/direct.ts': `
import type { Adapter } from '../adapter.js';
export const readDirect = (adapter: Adapter) => adapter.read({ functionName: 'exists' });
`
    };
    const entry = {
      rule: 1,
      file: 'pos/direct.ts',
      code: "export const readDirect = (adapter: Adapter) => adapter.read({ functionName: 'exists' });",
      reason: 'a reviewed exception'
    };

    expect(run({ files, allowlist: [entry] }).violations).deep.equal([]);

    const stale = run({ files: { 'pos/clean.ts': CLEAN }, allowlist: [entry] }).violations;
    expect(stale).lengthOf(1);
    expect(stale[0]).property('message').contains('stale ALLOWLIST entry');
  });
});
