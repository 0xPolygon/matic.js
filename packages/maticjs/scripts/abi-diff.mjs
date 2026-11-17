/**
 * Semantic diff of the vendored, generated contract ABIs, plus a scan of the
 * SDK source for the names a removed or changed item would break.
 *
 * Why it exists: a bump of `@polygonlabs/meta` regenerates every ABI file,
 * and the raw git diff is mostly key-order and legacy-key noise. A reviewer
 * needs to know which callable surface actually moved, and whether the SDK
 * refers to any of it. This script answers both deterministically so the
 * automation can paste the result into a pull request body.
 *
 * Flags are data, not failure: the CLI exits 0 whenever it ran.
 *
 * Run: `node scripts/abi-diff.mjs --before <dir> --after <dir> --src <dir>
 *   --hand <file> [--json <out>] [--md <out>] [--from <v>] [--to <v>]`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { keccak_256 } from '@noble/hashes/sha3.js';

// Generated files announce themselves on line one; `index.ts` and the
// hand-carried fragment file do not. Detecting by header, not by a contract
// list, means newly vendored contracts are picked up with no change here.
const GENERATED_HEADER = '// GENERATED FROM';

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const keccakHex = (text) => toHex(keccak_256(new TextEncoder().encode(text)));

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

// `tuple[2][]` -> `(t1,t2)[2][]`; anything else is already canonical.
const canonicalType = (param) => {
  if (param.type.startsWith('tuple')) {
    const inner = (param.components ?? []).map(canonicalType).join(',');
    return `(${inner})${param.type.slice('tuple'.length)}`;
  }
  return param.type;
};

const typeList = (params) => (params ?? []).map(canonicalType).join(',');

// Legacy ABIs carry `constant` / `payable` instead of `stateMutability`.
const mutabilityOf = (item) => {
  if (item.stateMutability) return item.stateMutability;
  if (item.constant) return 'view';
  if (item.payable) return 'payable';
  return 'nonpayable';
};

/**
 * Identity and semantic form of one ABI item.
 *
 * `key` is what makes two items "the same item" across versions: the
 * canonical signature for named kinds, the bare type for constructor,
 * fallback and receive. `semantic` is what makes them "unchanged": names,
 * `internalType`, key order and legacy keys are deliberately absent so a
 * pure reformat does not read as a change.
 */
export const describeItem = (item) => {
  const { type } = item;
  if (type === 'function' || type === 'event' || type === 'error') {
    const signature = `${item.name}(${typeList(item.inputs)})`;
    const hash = keccakHex(signature);
    const selector = type === 'event' ? `0x${hash}` : `0x${hash.slice(0, 8)}`;
    let semantic;
    if (type === 'function') {
      semantic = {
        inputs: typeList(item.inputs),
        outputs: typeList(item.outputs),
        stateMutability: mutabilityOf(item)
      };
    } else if (type === 'event') {
      semantic = {
        inputs: (item.inputs ?? []).map((p) => ({ type: canonicalType(p), indexed: !!p.indexed })),
        anonymous: !!item.anonymous
      };
    } else {
      semantic = { inputs: typeList(item.inputs) };
    }
    return {
      key: `${type} ${signature}`,
      kind: type,
      signature,
      selector,
      semantic: JSON.stringify(semantic)
    };
  }
  // constructor, fallback, receive: one per contract, keyed by type.
  const semantic = { inputs: typeList(item.inputs), stateMutability: mutabilityOf(item) };
  return {
    key: type,
    kind: type,
    signature: `${type}(${typeList(item.inputs)})`,
    selector: null,
    semantic: JSON.stringify(semantic)
  };
};

const bySignature = (a, b) =>
  a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : a.kind < b.kind ? -1 : 1;

const publicItem = ({ kind, signature, selector }) => ({ kind, signature, selector });

const isGeneratedFile = (file) => {
  if (!file.endsWith('.ts')) return false;
  const firstLine = readFileSync(file, 'utf8').split('\n', 1)[0];
  return firstLine.startsWith(GENERATED_HEADER);
};

const generatedFilesIn = (dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => join(dir, name))
    .filter(isGeneratedFile);

const loadArrays = async (file) => {
  const mod = await import(pathToFileURL(resolve(file)).href);
  return Object.values(mod).filter(Array.isArray);
};

const loadGenerated = async (dir) => {
  const out = new Map();
  for (const file of generatedFilesIn(dir)) {
    const name = basename(file, '.ts');
    const items = (await loadArrays(file)).flat();
    out.set(name, items);
  }
  return out;
};

const indexItems = (items) => {
  const index = new Map();
  for (const item of items) {
    const described = describeItem(item);
    index.set(described.key, { ...described, json: JSON.stringify(item) });
  }
  return index;
};

const diffContract = ({ before, after }) => {
  const b = indexItems(before);
  const a = indexItems(after);
  const added = [];
  const removed = [];
  const changed = [];
  let formatOnly = 0;
  for (const [key, item] of a) {
    const prior = b.get(key);
    if (!prior) added.push(publicItem(item));
    else if (prior.semantic !== item.semantic) changed.push(publicItem(item));
    else if (prior.json !== item.json) formatOnly += 1;
  }
  for (const [key, item] of b) {
    if (!a.has(key)) removed.push(publicItem(item));
  }
  return {
    added: added.sort(bySignature),
    removed: removed.sort(bySignature),
    changed: changed.sort(bySignature),
    formatOnly
  };
};

/**
 * Per-contract added / removed / changed lists and a format-only count,
 * plus the contracts present on one side only.
 */
export const diffAbis = async ({ beforeDir, afterDir }) => {
  const before = await loadGenerated(beforeDir);
  const after = await loadGenerated(afterDir);
  const contracts = {};
  for (const name of [...after.keys()].filter((n) => before.has(n)).sort()) {
    contracts[name] = diffContract({ before: before.get(name), after: after.get(name) });
  }
  return {
    contracts,
    onlyBefore: [...before.keys()].filter((n) => !after.has(n)).sort(),
    onlyAfter: [...after.keys()].filter((n) => !before.has(n)).sort()
  };
};

// Comments are matched first so an apostrophe inside one cannot pair with a
// real quote and swallow a literal: a missed literal would hide a break.
const TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

const walkTs = ({ dir, excluded }) => {
  const out = [];
  const visit = (current) => {
    if (excluded.some((e) => current === e)) return;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
  };
  visit(dir);
  return out.sort();
};

/**
 * Map of every string literal (and lower-cased 32-byte hex literal) in the
 * `.ts` files under `srcDir`, outside `excludeDirs`, to the files holding it.
 *
 * Over-approximating on purpose: a name that is a literal anywhere counts
 * as used for every contract. A false positive costs one human look; a
 * false negative would hide a break.
 */
export const collectUsages = ({ srcDir, excludeDirs = [] }) => {
  const root = resolve(srcDir);
  const usages = new Map();
  const note = (name, file) => {
    const files = usages.get(name) ?? [];
    if (!files.includes(file)) files.push(file);
    usages.set(name, files);
  };
  for (const file of walkTs({ dir: root, excluded: excludeDirs.map((d) => resolve(d)) })) {
    const shown = relative(root, file).split(sep).join('/');
    for (const match of readFileSync(file, 'utf8').matchAll(TOKEN)) {
      const [, single, double, template] = match;
      const literal = single ?? double ?? (template?.includes('${') ? undefined : template);
      if (literal === undefined) continue;
      note(literal, shown);
      if (HEX32.test(literal)) note(literal.toLowerCase(), shown);
    }
  }
  return usages;
};

export const collectUsedNames = ({ srcDir, excludeDirs }) =>
  new Set(collectUsages({ srcDir, excludeDirs }).keys());

const nameOf = (signature) => signature.slice(0, signature.indexOf('('));

/**
 * Removed or changed functions whose name is in `used`, and events whose
 * topic hash is in `used`. `used` may be the Set from `collectUsedNames` or
 * the Map from `collectUsages` (which also yields the files for the report).
 */
export const flagUsed = ({ diff, used }) => {
  const flagged = [];
  for (const [contract, result] of Object.entries(diff.contracts)) {
    for (const change of ['removed', 'changed']) {
      for (const item of result[change]) {
        let needle;
        if (item.kind === 'function') needle = nameOf(item.signature);
        else if (item.kind === 'event') needle = item.selector;
        else continue;
        if (!used.has(needle)) continue;
        const files = used instanceof Map ? used.get(needle) : [];
        flagged.push({ contract, change, ...item, files });
      }
    }
  }
  return flagged.sort(
    (a, b) =>
      (a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : 0) ||
      (a.change < b.change ? -1 : a.change > b.change ? 1 : 0) ||
      bySignature(a, b)
  );
};

/**
 * Function selectors present in both a generated ABI and the hand-carried
 * file: once the published ABI carries a fragment, the hand copy is a
 * duplicate that ethers v5 reports on every Interface construction.
 */
export const findHandCarriedOverlap = async ({ generatedDir, handFile }) => {
  const generated = new Map();
  for (const items of (await loadGenerated(generatedDir)).values()) {
    for (const item of items) {
      if (item.type !== 'function') continue;
      const described = describeItem(item);
      generated.set(described.selector, described.signature);
    }
  }
  const overlap = new Map();
  for (const item of (await loadArrays(handFile)).flat()) {
    if (item.type !== 'function') continue;
    const described = describeItem(item);
    if (generated.has(described.selector)) overlap.set(described.selector, described.signature);
  }
  return [...overlap]
    .map(([selector, signature]) => ({ signature, selector }))
    .sort(bySignature);
};

const itemLine = (item) =>
  `- \`${item.kind} ${item.signature}\`${item.selector ? ` \`${item.selector}\`` : ''}`;

const total = (r) => r.added.length + r.removed.length + r.changed.length;

/**
 * The caller owns the changeset level (the changeset file is written from the
 * same value), so the body only states it. Absent, as in the standalone CLI,
 * no level is asserted.
 */
const changesetSentence = (level) => {
  if (level === 'minor') {
    return '`minor` for `@polygonlabs/maticjs`, because the published ABI files lose or change an item, which breaks anyone using it through the `./abi` export (the major version is reserved for the SDK API). A person may still adjust the level.';
  }
  if (level === 'patch') {
    return '`patch` for `@polygonlabs/maticjs`, because the published ABI files only gain items or change format. A person may still adjust the level.';
  }
  if (level === 'empty') {
    return 'Empty, because no published file changed. A person may still adjust the level.';
  }
  return 'The level is set by the changeset file in this pull request. A person may still adjust it.';
};

/**
 * The pull-request body section. Deterministic: contracts and items sorted
 * by signature, no timestamps, so a rerun on the same input is byte-equal.
 */
export const renderMarkdown = (result, { from, to, changesetLevel }) => {
  const { diff, flagged, overlap } = result;
  const entries = Object.entries(diff.contracts);
  const touched = entries.filter(([, r]) => total(r) > 0 || r.formatOnly > 0);
  const unchanged = entries.length - touched.length;
  const lines = [
    `Updates the build-time dependency \`@polygonlabs/meta\` from ${from} to ${to} and regenerates the`,
    'vendored contract ABIs in `packages/maticjs/src/abi`.',
    ''
  ];
  if (flagged.length > 0) {
    lines.push(
      '> [!WARNING]',
      `> **Needs a decision before merge.** ${flagged.length} removed or changed item(s) appear in the SDK source.`,
      '> Check each one below, fix the calling code or confirm it is unaffected, and set the changeset',
      '> level accordingly.',
      ''
    );
  }
  lines.push('## ABI changes', '');
  if (touched.length > 0) {
    lines.push(
      '| Contract | Added | Removed | Changed | Format only |',
      '|---|---|---|---|---|',
      ...touched.map(
        ([name, r]) =>
          `| ${name} | ${r.added.length} | ${r.removed.length} | ${r.changed.length} | ${r.formatOnly} |`
      ),
      ''
    );
  }
  lines.push(`${unchanged} other contracts are unchanged.`, '');
  for (const name of diff.onlyAfter) lines.push(`Contract added: \`${name}\``, '');
  for (const name of diff.onlyBefore) lines.push(`Contract removed: \`${name}\``, '');
  for (const [name, r] of touched) {
    if (total(r) === 0) continue;
    lines.push(`### ${name}`);
    for (const [label, items] of [
      ['Added', r.added],
      ['Removed', r.removed],
      ['Changed', r.changed]
    ]) {
      if (items.length === 0) continue;
      lines.push(label, ...items.map(itemLine));
    }
    lines.push('');
  }
  lines.push('### Items the SDK source refers to');
  if (flagged.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push(
      ...flagged.map(
        (f) =>
          `- ${f.contract}: ${f.change} \`${f.kind} ${f.signature}\`${f.selector ? ` \`${f.selector}\`` : ''}, referenced in ${f.files.map((file) => `\`${file}\``).join(', ')}`
      ),
      ''
    );
  }
  if (overlap.length > 0) {
    lines.push(
      '### Hand-carried fragments now published',
      '`packages/maticjs/src/abi/failed-state-sync.ts` carries these functions, and the published ABI now',
      'has them too. Remove them there; the selector test fails until you do.',
      ...overlap.map((o) => `- \`${o.signature}\` \`${o.selector}\``),
      ''
    );
  }
  lines.push(
    '## Changeset',
    changesetSentence(changesetLevel),
    '',
    '## Before merging',
    '- Read the flagged items, if any.',
    '- Mark the pull request ready; the automated review then runs.',
    '- This pull request was opened by automation and is never merged by it.',
    ''
  );
  return lines.join('\n');
};

const USAGE =
  'Usage: abi-diff.mjs --before <dir> --after <dir> --src <dir> --hand <file> [--json <out>] [--md <out>] [--from <version>] [--to <version>]';

const parseArgs = (argv) => {
  const known = ['before', 'after', 'src', 'hand', 'json', 'md', 'from', 'to'];
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.startsWith('--') ? argv[i].slice(2) : undefined;
    const value = argv[i + 1];
    if (!name || !known.includes(name) || value === undefined) throw new Error(USAGE);
    args[name] = value;
  }
  for (const required of ['before', 'after', 'src', 'hand']) {
    if (!args[required]) throw new Error(USAGE);
  }
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const diff = await diffAbis({ beforeDir: args.before, afterDir: args.after });
  // The ABI directories hold the generated names themselves; scanning them
  // would flag every item as "used".
  const used = collectUsages({ srcDir: args.src, excludeDirs: [args.before, args.after] });
  const result = {
    diff,
    flagged: flagUsed({ diff, used }),
    overlap: await findHandCarriedOverlap({ generatedDir: args.after, handFile: args.hand })
  };
  if (args.json) writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
  if (args.md) {
    writeFileSync(args.md, renderMarkdown(result, { from: args.from ?? '?', to: args.to ?? '?' }));
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
