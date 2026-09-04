import {
  OmniError,
  type AcpErrorDetail,
  type ErrorClass,
  type ErrorRule,
  type MethodVerdict,
} from "@omni-acp/protocol";

/**
 * Classify one probe answer by CODE + a JSON pointer into `data` — never by message text (F17,
 * CONTRACTS.md §17.4). `-32602` with `data.<field>._errors` is the row that TEACHES the probe
 * the parameter is `configId` and not `optionId`; `-32603` with `data.details` is "implemented,
 * value rejected", which `code` alone cannot separate from a genuine internal error.
 *
 * Owned by M1-WP-E.
 */
export function classifyProbe(_e: unknown): MethodVerdict {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}

/**
 * Apply a descriptor's `errorRules`, in order, to a JSON-RPC error. NEVER throws — an
 * unmatched error is `{kind:"unclassified"}`, which is a diagnosis, not a crash.
 *
 * Owned by M1-WP-E.
 */
export function classifyAcpError(_rules: readonly ErrorRule[], _e: AcpErrorDetail): ErrorClass {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
