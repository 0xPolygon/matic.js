/**
 * Description shape used by the legacy contract-method registration
 * surface. The `: any` fields the legacy plugin runtime carried on
 * `extraFormatters` and `abiCoder` are narrowed to `unknown` — the
 * SDK no longer reads them, but the type is kept until Stage 3
 * formally removes the surface.
 */
export interface IMethod {
  name: string;
  call: string;
  params?: number;
  inputFormatter?: Array<(() => void) | null>;
  outputFormatter?: () => void;
  transformPayload?: () => void;
  extraFormatters?: unknown;
  defaultBlock?: string;
  defaultAccount?: string | null;
  abiCoder?: unknown;
  handleRevert?: boolean;
}
