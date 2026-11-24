/**
 * Contract-call gate over `packages/maticjs/src`.
 *
 * Enforces the rule in the repo-root AGENTS.md, section "Contract calls are
 * typed against the ABI (mandatory)". The compiler already rejects a method
 * name, argument list or result type that the contract's `as const` ABI does
 * not have. This gate covers what the compiler cannot say, using the
 * TypeScript checker so a call is recognised by what it calls and not by how
 * it is spelled. It fails (exit 1, listing file:line) on:
 *   (1) a call to `Adapter.read` in `src` outside `internal/contract-caller.ts`
 *       and `adapters/`: a read that skips the caller skips the ABI types and
 *       the one decoder that makes the three web3 libraries agree;
 *   (2) a `ContractCaller` method call (`read`, `write`, `prepareWrite`,
 *       `estimateGas`) whose method argument is neither a string literal, a
 *       `WriteCall` descriptor, nor a name a helper forwards as a type
 *       parameter bound to the ABI (`<N extends WriteName<typeof ABI>>`),
 *       so every contract method name stays greppable (the ABI-diff tooling
 *       finds the SDK's uses by scanning for string literals). A forwarded
 *       name is written as a literal by the helper's own caller and checked
 *       against the ABI by the compiler; a name typed `string`, or held in
 *       any other variable, is not accepted;
 *   (3) a doc-comment `@internal` marker: a member documented as internal but
 *       still typed and reachable is public in practice, so it is made private
 *       instead;
 *   (4) a class member that holds a `ContractCaller` and is not an ECMAScript
 *       `#` member, whatever it is named, or a member named `caller` that is
 *       not `#caller`: a TypeScript `private` member is still printed in the
 *       declarations and reachable from JavaScript, an ECMAScript `#` field is
 *       neither. A member holds a caller when its type is `ContractCaller`
 *       with any type arguments, alone or in a union (`| undefined`), whether
 *       declared or inferred, as a property or a constructor parameter
 *       property. Properties of constructor-config interfaces and object
 *       literals are inputs, not members of a handle, and are not covered;
 *   (5) a public `read`, `write`, `prepareWrite` or `estimateGas` signature on
 *       `ContractCaller` whose method parameter is typed `string` (or a union
 *       or type parameter that admits any `string`): the compiler accepts a
 *       literal name against such an overload, so re-adding one would let a
 *       call skip the ABI's names and types without any call site changing.
 *       Only the signatures callers can see count: the declared overloads, or
 *       the implementation when there are none. The implementation behind
 *       typed overloads is invisible to callers and may take a `string`.
 *
 * The allowlist below is the only place an exception can live. Each entry
 * needs a reason, and an entry that matches nothing fails, so the list stays
 * an exact record of the reviewed sites. It is expected to be empty.
 *
 * Generated ABI modules (`abi/`) and the vendored sources (`vendor/`) hold no
 * calls and are not walked.
 *
 * Run: `pnpm --filter @polygonlabs/maticjs run check:contract-calls`, or
 * `node scripts/check-contract-calls.mjs`. `tests/unit/contract-calls-gate.test.ts`
 * runs it in CI. It needs the `typescript` devDependency, which the repo
 * already has for the typecheck.
 */
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Reviewed exceptions: `{ rule, file, code, reason }`, where `file` is
 * relative to `src`, `code` is the trimmed source line and `rule` is 1 to 5.
 * Expected to stay empty.
 */
export const ALLOWLIST = [];

const CALLER_FILE = 'internal/contract-caller.ts';
const ADAPTER_FILE = 'adapter.ts';
const CALLER_METHODS = new Set(['read', 'write', 'prepareWrite', 'estimateGas']);
const NOT_WALKED = /^(abi|vendor)\//;

const posix = (path) => path.split(sep).join('/');

const isStringLiteralNode = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** The declaration the call's callee names, with the file it lives in. */
const declarationsOf = ({ checker, callee }) => {
  const nameNode = ts.isPropertyAccessExpression(callee)
    ? callee.name
    : ts.isElementAccessExpression(callee) && isStringLiteralNode(callee.argumentExpression)
      ? callee.argumentExpression
      : undefined;
  if (nameNode === undefined) return { name: undefined, declarations: [] };
  const name = ts.isIdentifier(nameNode) ? nameNode.text : nameNode.text;
  const symbol = checker.getSymbolAtLocation(nameNode);
  return { name, declarations: symbol?.declarations ?? [] };
};

/** `true` when the argument is a `{ method, args }` call descriptor (a `WriteCall` value). */
const isDescriptor = ({ checker, node }) => {
  const type = checker.getTypeAtLocation(node);
  const parts = type.isUnion() ? type.types : [type];
  return parts.every(
    (part) =>
      (part.flags & ts.TypeFlags.Object) !== 0 &&
      part.getProperty('method') !== undefined &&
      part.getProperty('args') !== undefined
  );
};

/** `true` when the argument is a helper's type parameter, which the compiler binds to the ABI's names. */
const isForwardedName = ({ checker, node }) => {
  // The declared type, not the type at the use: where the callee expects a
  // string, the checker reports a type parameter by its constraint.
  const declared = ts.isIdentifier(node)
    ? checker.getSymbolAtLocation(node)?.valueDeclaration
    : undefined;
  const type =
    declared !== undefined && ts.isParameter(declared) && declared.type !== undefined
      ? checker.getTypeFromTypeNode(declared.type)
      : checker.getTypeAtLocation(node);
  return (type.flags & ts.TypeFlags.TypeParameter) !== 0;
};

/**
 * `true` when `type` is the `ContractCaller` class, with any type arguments,
 * or a union that contains it (`ContractCaller<...> | undefined`).
 */
const isCallerType = ({ type, srcDir }) => {
  const parts = type.isUnion() ? type.types : [type];
  return parts.some((part) =>
    (part.symbol?.declarations ?? []).some(
      (d) =>
        ts.isClassDeclaration(d) &&
        d.name?.text === 'ContractCaller' &&
        posix(relative(srcDir, d.getSourceFile().fileName)) === CALLER_FILE
    )
  );
};

/** `true` when a method's first-parameter type admits any `string` (the `string` keyword, alone, in a union, or as a type parameter's constraint). */
const admitsAnyString = ({ typeNode, signature }) => {
  if (typeNode === undefined) return true;
  if (typeNode.kind === ts.SyntaxKind.StringKeyword) return true;
  if (ts.isParenthesizedTypeNode(typeNode))
    return admitsAnyString({ typeNode: typeNode.type, signature });
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some((t) => admitsAnyString({ typeNode: t, signature }));
  }
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    const parameter = signature.typeParameters?.find((p) => p.name.text === typeNode.typeName.text);
    if (parameter !== undefined) {
      return (
        parameter.constraint !== undefined &&
        admitsAnyString({ typeNode: parameter.constraint, signature })
      );
    }
  }
  return false;
};

/** The signatures of `ContractCaller`'s methods that callers can see. */
const publicCallSignatures = ({ classNode }) => {
  const methods = classNode.members.filter(
    (m) =>
      ts.isMethodDeclaration(m) &&
      ts.isIdentifier(m.name) &&
      CALLER_METHODS.has(m.name.text) &&
      (ts.getCombinedModifierFlags(m) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) ===
        0
  );
  return [...new Set(methods.map((m) => m.name.text))].flatMap((name) => {
    const named = methods.filter((m) => m.name.text === name);
    const overloads = named.filter((m) => m.body === undefined);
    return overloads.length > 0 ? overloads : named;
  });
};

const lineOf = ({ sf, node }) => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, code: sf.text.split('\n')[line].trim() };
};

/**
 * Walk `program`'s files under `srcDir` and return every violation plus how
 * many calls were inspected. Exported for the unit test, which feeds it small
 * synthetic programs.
 */
export const inspectProgram = ({ program, srcDir, allowlist = ALLOWLIST }) => {
  const checker = program.getTypeChecker();
  const violations = [];
  const counts = { callerCalls: 0, adapterReads: 0 };
  const unmatched = allowlist.map((entry) => ({ ...entry }));

  const report = ({ rule, file, line, code, message }) => {
    const hit = unmatched.findIndex((e) => e.rule === rule && e.file === file && e.code === code);
    if (hit !== -1) {
      unmatched.splice(hit, 1);
      return;
    }
    violations.push({ rule, file, line, message });
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const file = posix(relative(srcDir, sf.fileName));
    if (file.startsWith('..') || NOT_WALKED.test(file)) continue;

    const seenComments = new Set();
    const scanComments = (node) => {
      for (const pos of [node.getFullStart(), node.getEnd()]) {
        const ranges = [
          ...(ts.getLeadingCommentRanges(sf.text, pos) ?? []),
          ...(ts.getTrailingCommentRanges(sf.text, pos) ?? [])
        ];
        for (const range of ranges) {
          if (seenComments.has(range.pos)) continue;
          seenComments.add(range.pos);
          if (!/@internal\b/.test(sf.text.slice(range.pos, range.end))) continue;
          const { line } = sf.getLineAndCharacterOfPosition(range.pos);
          const text = sf.text.slice(range.pos, range.end).split('\n');
          const offset = text.findIndex((l) => /@internal\b/.test(l));
          report({
            rule: 3,
            file,
            line: line + 1 + offset,
            code: text[offset].trim(),
            message: 'an @internal marker: make the member private instead of marking it'
          });
        }
      }
    };

    const visit = (node) => {
      scanComments(node);

      if (
        file === CALLER_FILE &&
        ts.isClassDeclaration(node) &&
        node.name?.text === 'ContractCaller'
      ) {
        for (const signature of publicCallSignatures({ classNode: node })) {
          const [first] = signature.parameters;
          if (!admitsAnyString({ typeNode: first?.type, signature })) continue;
          const { line, code } = lineOf({ sf, node: signature });
          report({
            rule: 5,
            file,
            line,
            code,
            message: `ContractCaller.${signature.name.text} has a public signature whose method parameter is typed string: type it against the ABI's names so the compiler can reject a name the ABI lacks`
          });
        }
      }

      if (ts.isCallExpression(node)) {
        const { name, declarations } = declarationsOf({ checker, callee: node.expression });
        const declaredIn = (d) => posix(relative(srcDir, d.getSourceFile().fileName));
        const onCallerClass = declarations.some(
          (d) =>
            declaredIn(d) === CALLER_FILE &&
            d.parent !== undefined &&
            ts.isClassDeclaration(d.parent) &&
            d.parent.name?.text === 'ContractCaller'
        );

        if (name === 'read') {
          // Whichever type the receiver has (the interface or a class that
          // implements it), a `read` that resolves into the adapter layer is
          // an Adapter.read.
          const onAdapter = declarations.some((d) => {
            const where = declaredIn(d);
            return where === ADAPTER_FILE || where.startsWith('adapters/');
          });
          if (onAdapter) {
            counts.adapterReads += 1;
            if (file !== CALLER_FILE && !file.startsWith('adapters/')) {
              const { line, code } = lineOf({ sf, node });
              report({
                rule: 1,
                file,
                line,
                code,
                message:
                  'Adapter.read outside ContractCaller: read through a ContractCaller so the ABI types and the decoder apply'
              });
            }
          }
        }

        if (
          name !== undefined &&
          CALLER_METHODS.has(name) &&
          onCallerClass &&
          file !== CALLER_FILE
        ) {
          counts.callerCalls += 1;
          const [first] = node.arguments;
          const literal = first !== undefined && isStringLiteralNode(first);
          const accepted =
            literal ||
            (first !== undefined &&
              (isDescriptor({ checker, node: first }) ||
                isForwardedName({ checker, node: first })));
          if (!accepted) {
            const { line, code } = lineOf({ sf, node });
            report({
              rule: 2,
              file,
              line,
              code,
              message: `ContractCaller.${name} takes a string literal, a WriteCall descriptor or a type-parameter name forwarded by a helper as its method, so method names stay greppable`
            });
          }
        }
      }

      const isClassMember =
        ts.isPropertyDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node);
      const isParameterProperty =
        ts.isParameter(node) &&
        ts.isConstructorDeclaration(node.parent) &&
        (ts.getCombinedModifierFlags(node) &
          (ts.ModifierFlags.Public |
            ts.ModifierFlags.Private |
            ts.ModifierFlags.Protected |
            ts.ModifierFlags.Readonly)) !==
          0;
      if (isClassMember || isParameterProperty) {
        const named =
          node.name !== undefined &&
          (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
          node.name.text === 'caller';
        const holdsCaller =
          !(node.name !== undefined && ts.isPrivateIdentifier(node.name)) &&
          !ts.isMethodDeclaration(node) &&
          !ts.isGetAccessorDeclaration(node) &&
          !ts.isSetAccessorDeclaration(node) &&
          isCallerType({ type: checker.getTypeAtLocation(node), srcDir });
        if (named || holdsCaller) {
          const { line, code } = lineOf({ sf, node });
          report({
            rule: 4,
            file,
            line,
            code,
            message: named
              ? 'a member named caller must be an ECMAScript #caller field, so it is neither printed in the declarations nor reachable'
              : 'a class member that holds a ContractCaller must be an ECMAScript # member, so it is neither printed in the declarations nor reachable'
          });
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  for (const stale of unmatched) {
    violations.push({
      rule: stale.rule,
      file: stale.file,
      line: 0,
      message: `stale ALLOWLIST entry matches nothing: ${stale.code}`
    });
  }
  return { violations, counts };
};

/** Check the real `src`, typed with the package's own tsconfig. */
export const checkContractCalls = ({ srcDir = join(PACKAGE_DIR, 'src') } = {}) => {
  const configPath = resolve(PACKAGE_DIR, 'tsconfig.json');
  const config = ts.getParsedCommandLineOfConfigFile(
    configPath,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (d) => {
        throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
      }
    }
  );
  const root = resolve(srcDir) + sep;
  const program = ts.createProgram({
    rootNames: config.fileNames.filter((f) => resolve(f).startsWith(root)),
    options: config.options
  });
  return inspectProgram({ program, srcDir: resolve(srcDir) });
};

const parentDirs = (file) => {
  const dirs = [];
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) dirs.push(dir);
  return dirs;
};

/**
 * Check in-memory sources: `files` maps a path relative to a virtual `src`
 * to its text. The files stand alone, so a test declares the few types the
 * gate looks for (`ContractCaller` in `internal/contract-caller.ts`, `Adapter`
 * in `adapter.ts`) beside the code it wants judged.
 */
export const checkSources = ({ files, allowlist = [] }) => {
  const srcDir = '/virtual/src';
  const sources = new Map(Object.entries(files).map(([name, text]) => [join(srcDir, name), text]));
  const options = {
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: []
  };
  const host = ts.createCompilerHost(options);
  const { fileExists, readFile, getSourceFile, directoryExists } = host;
  const dirs = new Set([...sources.keys()].flatMap((name) => parentDirs(name)));
  host.fileExists = (name) => sources.has(name) || fileExists(name);
  host.directoryExists = (name) => dirs.has(name) || (directoryExists?.(name) ?? false);
  host.readFile = (name) => sources.get(name) ?? readFile(name);
  host.getSourceFile = (name, languageVersion, ...rest) =>
    sources.has(name)
      ? ts.createSourceFile(name, sources.get(name), languageVersion, true)
      : getSourceFile(name, languageVersion, ...rest);
  const program = ts.createProgram({ rootNames: [...sources.keys()], options, host });
  return inspectProgram({ program, srcDir, allowlist });
};

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { violations, counts } = checkContractCalls({
    srcDir: process.argv[2] ?? join(PACKAGE_DIR, 'src')
  });
  if (violations.length > 0) {
    console.error(
      'contract-calls gate FAILED (see AGENTS.md, "Contract calls are typed against the ABI"):'
    );
    for (const v of violations) {
      console.error(`  src/${v.file}:${v.line}: (${v.rule}) ${v.message}`);
    }
    process.exit(1);
  }
  console.log(
    `contract-calls gate passed: ${counts.callerCalls} ContractCaller calls and ${counts.adapterReads} Adapter.read calls checked, ${ALLOWLIST.length} allowlisted`
  );
}
