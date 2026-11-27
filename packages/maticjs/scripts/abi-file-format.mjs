/**
 * The one definition of what a generated `src/abi/<Name>.ts` file looks like.
 *
 * Why it is shared: `generate-abis.ts` writes these files and the meta sync
 * pull-request step must decide whether a file it is about to commit is one
 * the generator could have written. Two copies of the format would let the
 * check and the writer drift apart, so both import this module. It is plain
 * ESM with no dependency, because the pull-request step installs nothing.
 */

const HEADER_PATTERN =
  /^\/\/ GENERATED FROM `([^`\n]+)` — DO NOT EDIT\.\n\/\/ Regenerate with `pnpm run codegen`\. See scripts\/generate-abis\.ts\.\n\nexport const ([A-Za-z0-9_]+)ABI = /;
const FOOTER = ' as const;\n';

export const renderAbiFile = ({ specifier, name, abi }) =>
  `// GENERATED FROM \`${specifier}\` — DO NOT EDIT.\n` +
  `// Regenerate with \`pnpm run codegen\`. See scripts/generate-abis.ts.\n\n` +
  `export const ${name}ABI = ${JSON.stringify(abi, null, 2)}${FOOTER}`;

/**
 * Reads a generated file back into its parts, or throws. The ABI is parsed
 * as JSON and never evaluated, so a hostile file cannot run code here. A
 * successful parse does not prove the file is canonical: compare
 * `renderAbiFile` of the result with the original text for that.
 */
export const parseAbiFile = ({ text }) => {
  const head = HEADER_PATTERN.exec(text);
  if (!head) throw new Error('not a generated ABI file: header does not match');
  if (!text.endsWith(FOOTER)) throw new Error('not a generated ABI file: footer does not match');
  const json = text.slice(head[0].length, text.length - FOOTER.length);
  let abi;
  try {
    abi = JSON.parse(json);
  } catch {
    throw new Error('not a generated ABI file: the ABI is not JSON');
  }
  return { specifier: head[1], name: head[2], abi };
};
