export interface AbiFileParts {
  specifier: string;
  name: string;
  abi: unknown;
}

export function renderAbiFile(parts: AbiFileParts): string;
export function parseAbiFile(params: { text: string }): AbiFileParts;
