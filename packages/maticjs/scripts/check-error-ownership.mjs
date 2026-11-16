/**
 * Error-ownership gate over `packages/maticjs/src`.
 *
 * Enforces the rule in the repo-root AGENTS.md, section "Error ownership
 * (mandatory)": an SDK error is thrown only for a condition the SDK's own
 * code detected, and an error from ethers, viem, the wallet or the RPC
 * transport is rethrown exactly as it came. The identity falsification
 * tests prove that at runtime for the paths they drive; this gate covers
 * every path statically, so a reintroduced wrap fails CI even where no test
 * reaches it. Read that section before changing or loosening anything here.
 *
 * It fails (exit 1, listing file:line) on:
 *   (a) a `cause` set inside an error handler that checks the caught error
 *       against an ethers or viem identity (that cause IS a library error),
 *       and any `cause` set anywhere under `src/adapters/`;
 *   (b) an error handler that both checks an ethers or viem identity and
 *       constructs an SDK error class, with or without a cause: that mints
 *       an SDK error for a failure in code we do not own;
 *   (c) a `cause` set anywhere in `src` that is not in ALLOWED_CAUSE_SITES,
 *       and an allowlist entry that no longer matches a site, so the list
 *       stays an exact record of the reviewed sites.
 *
 * "Error handler" means a `catch` clause, a `.catch(handler)` argument, the
 * rejection handler of `.then(onFulfilled, onRejected)`, and the body of a
 * helper that itself checks a library identity. The rejection handlers
 * matter most: `wait()` outcomes are classified there, which is exactly
 * where SDK codes were once minted from library errors.
 *
 * The SDK class names are read from `src/errors.ts`'s name arrays on every
 * run, so a new class is covered without touching this file.
 *
 * Run: `pnpm --filter @polygonlabs/maticjs run check:error-ownership`, or
 * `node scripts/check-error-ownership.mjs [srcDir]`. The unit test
 * `tests/unit/no-library-cause.test.ts` runs it in CI. Plain Node, no deps.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The only `cause` sites allowed in `src`, each by file and the trimmed code
 * line that sets it. None carries an ethers, viem, wallet or RPC error: they
 * are the SDK's own fetch and parse failures, plus the operation wrapper,
 * which wraps only an error the SDK itself raised. Repeated entries are
 * repeated sites.
 */
export const ALLOWED_CAUSE_SITES = [
  {
    file: 'errors.ts',
    code: 'throw new error({ info: merged, cause: inner instanceof Error ? inner : undefined });',
    reason: 'withOperation collapsing a nested SDK operation error: keeps its SDK cause'
  },
  {
    file: 'errors.ts',
    code: 'throw new error({ info, cause: err });',
    reason: 'withOperation: wraps only an SDK error; anything else is rethrown first'
  },
  {
    file: 'internal/proof-api-client.ts',
    code: 'cause: err instanceof Error ? err : new Error(String(err))',
    reason: 'proof API base URL is not an absolute URL (WHATWG URL parser)'
  },
  {
    file: 'internal/proof-api-client.ts',
    code: 'cause: err instanceof Error ? err : new Error(String(err))',
    reason: 'proof API quantity is not a number (quantity parser)'
  },
  {
    file: 'services/address-service.ts',
    code: 'cause: err instanceof Error ? err : new Error(String(err))',
    reason: 'address index URL is not an absolute URL (WHATWG URL parser)'
  },
  {
    file: 'utils/bytes.ts',
    code: 'cause: err instanceof Error ? err : new Error(String(err))',
    reason: 'hex parser error inside hexToBytes'
  },
  {
    file: 'utils/http_request.ts',
    code: 'cause: err instanceof Error ? err : new Error(thrownValueMessage(err))',
    reason: "the SDK's own HTTP helper: fetch's network-layer error"
  },
  {
    file: 'utils/http_request.ts',
    code: 'cause: err instanceof Error ? err : new Error(String(err))',
    reason: "the SDK's own HTTP helper: JSON.parse's SyntaxError"
  }
];

/** ethers' error codes (v5 and v6). A string literal of one in a handler is a library check. */
const ETHERS_CODES = [
  'UNKNOWN_ERROR',
  'NOT_IMPLEMENTED',
  'UNSUPPORTED_OPERATION',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'TIMEOUT',
  'BAD_DATA',
  'CANCELLED',
  'BUFFER_OVERRUN',
  'NUMERIC_FAULT',
  'INVALID_ARGUMENT',
  'MISSING_ARGUMENT',
  'UNEXPECTED_ARGUMENT',
  'VALUE_MISMATCH',
  'CALL_EXCEPTION',
  'INSUFFICIENT_FUNDS',
  'NONCE_EXPIRED',
  'REPLACEMENT_UNDERPRICED',
  'TRANSACTION_REPLACED',
  'UNCONFIGURED_NAME',
  'OFFCHAIN_FAULT',
  'ACTION_REJECTED',
  'UNPREDICTABLE_GAS_LIMIT'
];

/** Error classes that belong to neither the SDK nor a web3 library. */
const NEUTRAL_CLASSES = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'RangeError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'VError',
  'WError',
  'MultiError'
]);

// ─── Source masking ─────────────────────────────────────────────────────────

const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^'].concat(['']));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|throw|in|of|void|delete)$/;

/**
 * Two same-length copies of `source`: `code` with comments blanked, and
 * `shape` with comments and string, template and regex contents blanked, so
 * brace matching and key detection never trip on text. Newlines survive in
 * both, so offsets map to the same line.
 */
const mask = (source) => {
  const code = [...source];
  const shape = [...source];
  const blank = (arr, i) => {
    if (arr[i] !== '\n') arr[i] = ' ';
  };
  // Modes: code, or a template literal; `${` pushes a code frame.
  const stack = [{ mode: 'code', depth: 0 }];
  let i = 0;
  const lastSignificant = () => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(shape[j])) j--;
    return j < 0 ? '' : shape[j];
  };
  const precedingWord = () => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(shape[j])) j--;
    return shape.slice(Math.max(0, j - 10), j + 1).join('');
  };
  while (i < source.length) {
    const frame = stack[stack.length - 1];
    const c = source[i];
    const next = source[i + 1];
    if (frame.mode === 'template') {
      if (c === '\\') {
        blank(shape, i);
        blank(shape, i + 1);
        i += 2;
      } else if (c === '`') {
        stack.pop();
        i += 1;
      } else if (c === '$' && next === '{') {
        stack.push({ mode: 'code', depth: 0 });
        i += 2;
      } else {
        blank(shape, i);
        i += 1;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        blank(code, i);
        blank(shape, i);
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (; i < stop; i++) {
        blank(code, i);
        blank(shape, i);
      }
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < source.length && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') blank(shape, i++);
        blank(shape, i++);
      }
      i++;
      continue;
    }
    if (c === '`') {
      stack.push({ mode: 'template' });
      i++;
      continue;
    }
    if (
      c === '/' &&
      (REGEX_PRECEDERS.has(lastSignificant()) || REGEX_KEYWORDS.test(precedingWord()))
    ) {
      i++;
      let inClass = false;
      while (i < source.length && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') {
          blank(shape, i++);
        } else if (r === '[') {
          inClass = true;
        } else if (r === ']') {
          inClass = false;
        } else if (r === '/' && !inClass) {
          break;
        }
        blank(shape, i++);
      }
      i++;
      continue;
    }
    if (c === '{') frame.depth++;
    if (c === '}') {
      if (frame.depth === 0 && stack.length > 1) {
        stack.pop();
        i++;
        continue;
      }
      frame.depth--;
    }
    i++;
  }
  return { code: code.join(''), shape: shape.join('') };
};

/** Escapes every RegExp metacharacter, backslash included, so a name is matched literally. */
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

const PAIRS = { '(': ')', '[': ']', '{': '}' };

/** Index of the bracket closing the one at `open` in `shape`, or the end. */
const closing = (shape, open) => {
  const want = [];
  for (let i = open; i < shape.length; i++) {
    const c = shape[i];
    if (c in PAIRS) want.push(PAIRS[c]);
    else if (c === ')' || c === ']' || c === '}') {
      want.pop();
      if (want.length === 0) return i;
    }
  }
  return shape.length;
};

/** The top-level comma-separated argument ranges between `open` and its closer. */
const argumentRanges = (shape, open) => {
  const close = closing(shape, open);
  const ranges = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = shape[i];
    if (c in PAIRS) depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      ranges.push([start, i]);
      start = i + 1;
    }
  }
  ranges.push([start, close]);
  return ranges;
};

// ─── Library identity ───────────────────────────────────────────────────────

const ETHERS_CODE_LITERAL = new RegExp(`['"\`](?:${ETHERS_CODES.join('|')})['"\`]`);

/**
 * True when `text` (comments blanked, strings kept) checks an error against
 * an ethers or viem identity: `isError(…)`, a known identity helper, an
 * `instanceof` of a library error class, an ethers code literal, or a
 * comparison of `.name` with a library error class name.
 */
const checksLibraryIdentity = ({ text, sdkNames, helpers }) => {
  if (/\bisError\s*\(/.test(text)) return true;
  if (ETHERS_CODE_LITERAL.test(text)) return true;
  for (const [, name] of text.matchAll(/\binstanceof\s+(?:[\w$]+\.)*([\w$]+)/g)) {
    if (/Error$/.test(name) && !NEUTRAL_CLASSES.has(name) && !sdkNames.has(name)) return true;
  }
  for (const [, name] of text.matchAll(
    /\.name\s*[!=]==?\s*['"`]([\w$]+)['"`]|['"`]([\w$]+)['"`]\s*[!=]==?\s*[\w$.]*\.name\b/g
  )) {
    if (name !== undefined && /Error$/.test(name) && !NEUTRAL_CLASSES.has(name)) {
      if (!sdkNames.has(name)) return true;
    }
  }
  for (const helper of helpers) {
    if (new RegExp(`(?<![\\w$.])${escapeRegExp(helper)}\\s*\\(`).test(text)) return true;
  }
  return false;
};

// ─── Scopes ─────────────────────────────────────────────────────────────────

/** Error-handler ranges in one file: catch clauses and promise rejection handlers. */
const handlerScopes = (shape) => {
  const scopes = [];
  for (const m of shape.matchAll(/(?<![.\w$])catch\s*(?:\([^)]*\)\s*)?\{/g)) {
    const open = m.index + m[0].length - 1;
    scopes.push({ start: m.index, end: closing(shape, open), kind: 'catch' });
  }
  for (const m of shape.matchAll(/\.catch\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    scopes.push({ start: open, end: closing(shape, open), kind: '.catch()' });
  }
  for (const m of shape.matchAll(/\.then\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const args = argumentRanges(shape, open);
    if (args.length >= 2) {
      const [start, end] = args[1];
      scopes.push({ start, end, kind: '.then() rejection handler' });
    }
  }
  return scopes;
};

/** Named functions and function-valued consts in one file, with their body ranges. */
const definitions = (shape) => {
  const defs = [];
  for (const m of shape.matchAll(/\bfunction\s*\*?\s*([\w$]+)\s*[(<]/g)) {
    const brace = shape.indexOf('{', m.index + m[0].length);
    if (brace === -1) continue;
    // Skip past the parameter list and return type to the body's brace.
    const params = shape.indexOf('(', m.index);
    const afterParams = closing(shape, params);
    const body = shape.indexOf('{', afterParams);
    if (body === -1) continue;
    defs.push({ name: m[1], start: m.index, end: closing(shape, body) });
  }
  for (const m of shape.matchAll(/\b(?:const|let)\s+([\w$]+)\s*(?::[^=]+)?=(?!=)/g)) {
    let depth = 0;
    let end = shape.length;
    for (let i = m.index + m[0].length; i < shape.length; i++) {
      const c = shape[i];
      if (c in PAIRS) depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      if ((c === ';' && depth === 0) || depth < 0) {
        end = i;
        break;
      }
    }
    // Only function-valued consts are helpers: a const holding an object
    // or a call result is not a handler of its own.
    const init = shape.slice(m.index + m[0].length, end).trimStart();
    if (!/^(?:async\b\s*)?(?:function\b|\(|[\w$]+\s*=>|<)/.test(init)) continue;
    defs.push({ name: m[1], start: m.index, end });
  }
  return defs;
};

// ─── Cause sites ────────────────────────────────────────────────────────────

/**
 * Offsets in `shape` where an object sets a `cause`: `cause: value` or the
 * shorthand `{ cause }`. Type annotations (`cause?: Error`, `cause: unknown`),
 * destructuring patterns and the internal `withRootMessage(…)` call, which
 * reads an existing cause to format a message, set nothing.
 */
const causeSites = ({ shape, lineOf, lines }) => {
  const sites = [];
  for (const m of shape.matchAll(/(?<![\w$.?])cause\s*:(?!\s*(?:unknown|Error)\b)/g)) {
    sites.push(m.index);
  }
  for (const m of shape.matchAll(/[{,]\s*cause\s*(?=[,}])/g)) {
    const rest = shape.slice(shape.indexOf('}', m.index)).match(/^\}\s*(.)(.)?/s);
    const after = rest === null ? '' : rest[1];
    if (after === ':' || (after === '=' && rest[2] !== '=')) continue;
    if (after === ')' && /^\}\s*\)\s*=>/.test(shape.slice(shape.indexOf('}', m.index)))) continue;
    sites.push(m.index + m[0].indexOf('cause'));
  }
  return sites.filter((offset) => !lines[lineOf(offset) - 1].includes('withRootMessage('));
};

// ─── Gate ───────────────────────────────────────────────────────────────────

const sourceFiles = (dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'vendor' ? [] : sourceFiles(path);
      return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
    });

/** The SDK's error class names, from `errors.ts`'s CONDITION_NAMES and OPERATION_NAMES. */
const sdkErrorNames = (srcDir) => {
  const text = readFileSync(join(srcDir, 'errors.ts'), 'utf8');
  const names = new Set();
  for (const list of ['CONDITION_NAMES', 'OPERATION_NAMES']) {
    const m = text.match(new RegExp(`const ${list}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`));
    if (m === null) {
      throw new Error(
        `errors.ts no longer declares ${list}; update this gate before relying on it`
      );
    }
    for (const [, name] of m[1].matchAll(/['"]([\w$]+)['"]/g)) names.add(name);
  }
  if (names.size === 0) throw new Error('read no SDK error names from errors.ts');
  return names;
};

const article = (kind) => `${/^[aeiou]/i.test(kind) ? 'an' : 'a'} ${kind}`;

const lineIndex = (text) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

/**
 * Every violation of the error-ownership rule under `srcDir`, as
 * `{ file, line, rule, message }` with `file` relative to `srcDir`.
 */
export const checkErrorOwnership = (srcDir) => {
  const sdkNames = sdkErrorNames(srcDir);
  const files = sourceFiles(srcDir).map((path) => {
    const source = readFileSync(path, 'utf8');
    const { code, shape } = mask(source);
    return {
      file: relative(srcDir, path).split(sep).join('/'),
      source,
      code,
      shape,
      lines: source.split('\n'),
      lineOf: lineIndex(source)
    };
  });

  // Helpers whose own body checks a library identity, to a fixpoint so a
  // helper calling a helper counts too.
  const helpers = new Set();
  const allDefs = files.flatMap((f) => definitions(f.shape).map((d) => ({ ...d, f })));
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of allDefs) {
      if (helpers.has(d.name)) continue;
      const text = d.f.code.slice(d.start, d.end).replace(/^[^=({]*/, '');
      if (checksLibraryIdentity({ text, sdkNames, helpers })) {
        helpers.add(d.name);
        grew = true;
      }
    }
  }

  const sdkConstructor = new RegExp(`\\bnew\\s+(${[...sdkNames].join('|')})\\s*\\(`, 'g');
  const violations = [];
  const unmatched = ALLOWED_CAUSE_SITES.map((entry) => ({ ...entry }));

  for (const f of files) {
    const causes = causeSites(f);
    // A site inside nested scopes (a helper holding a catch) is reported once per rule.
    const reported = new Set();
    const report = ({ offset, rule, message }) => {
      const key = `${f.lineOf(offset)}:${rule}`;
      if (rule !== 'c' && reported.has(key)) return;
      reported.add(key);
      violations.push({ file: f.file, line: f.lineOf(offset), rule, message });
    };

    const scopes = [
      ...handlerScopes(f.shape),
      ...definitions(f.shape)
        .filter((d) => helpers.has(d.name))
        .map((d) => ({ ...d, kind: `helper (${d.name})` }))
    ];
    for (const scope of scopes) {
      const text = f.code.slice(scope.start, scope.end);
      if (!checksLibraryIdentity({ text, sdkNames, helpers })) continue;
      for (const offset of causes) {
        if (offset >= scope.start && offset < scope.end) {
          report({
            offset,
            rule: 'a',
            message: `cause set in ${article(scope.kind)} that checks an ethers/viem error: that cause is a library error`
          });
        }
      }
      const shapeText = f.shape.slice(scope.start, scope.end);
      for (const m of shapeText.matchAll(sdkConstructor)) {
        report({
          offset: scope.start + m.index,
          rule: 'b',
          message: `${m[1]} built in ${article(scope.kind)} that checks an ethers/viem error: a failure in code we do not own`
        });
      }
    }

    for (const offset of causes) {
      const line = f.lineOf(offset);
      if (f.file.startsWith('adapters/')) {
        report({ offset, rule: 'a', message: 'an adapter sets a cause; adapters may set none' });
        continue;
      }
      const text = f.lines[line - 1].trim();
      const hit = unmatched.findIndex((e) => e.file === f.file && e.code === text);
      if (hit === -1) {
        report({
          offset,
          rule: 'c',
          message: `cause site not in ALLOWED_CAUSE_SITES: ${text}`
        });
      } else {
        unmatched.splice(hit, 1);
      }
    }
  }

  for (const stale of unmatched) {
    violations.push({
      file: stale.file,
      line: 0,
      rule: 'c',
      message: `stale ALLOWED_CAUSE_SITES entry matches no site: ${stale.code}`
    });
  }
  return violations;
};

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const srcDir = resolve(
    process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
  );
  const violations = checkErrorOwnership(srcDir);
  if (violations.length > 0) {
    console.error('error-ownership gate FAILED (see AGENTS.md, "Error ownership (mandatory)"):');
    for (const v of violations) {
      console.error(`  src/${v.file}:${v.line}: (${v.rule}) ${v.message}`);
    }
    process.exit(1);
  }
  console.log(
    `error-ownership gate passed: ${ALLOWED_CAUSE_SITES.length} reviewed cause sites, no library error wrapped`
  );
}
