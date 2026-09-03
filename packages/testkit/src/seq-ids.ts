import { OmniError, type IdGen, type Logger } from "@omni-acp/protocol";

/** Deterministic ids: d_000...001, w_000...001, t_000...001. */
export function seqIds(): IdGen {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.seqIds)");
}

export function nullLogger(): Logger {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.nullLogger)");
}
