import { ERROR_STATUS, OmniError, type OmniErrorBody } from "@omni-acp/protocol";

/**
 * The single error mapper. It reads `ERROR_STATUS` and nothing else — there is no other status
 * logic anywhere in the HTTP layer, which is what keeps the adapter free of domain judgement
 * (CONTRACTS.md §9, D15 constraint 1).
 *
 * The agent's JSON-RPC error travels in `acp` verbatim and is never reshaped.
 */
export function toErrorResponse(e: unknown): { status: number; body: OmniErrorBody } {
  const omni = classify(e);
  return { status: ERROR_STATUS[omni.code], body: omni.toBody() };
}

function classify(e: unknown): OmniError {
  if (e instanceof OmniError) return e;

  // zod is `@omni-acp/protocol`'s dependency, not this package's (§3.2), so a `ZodError` is
  // recognised structurally rather than with `instanceof` — which is also what makes this work
  // across realms, where `instanceof` silently would not.
  const zod = asZodError(e);
  if (zod !== null) {
    return new OmniError("bad_request", zodMessage(zod), { cause: e });
  }

  // `c.req.json()` on a malformed or empty body. A 400 with a sentence, never a 500 with a stack.
  if (e instanceof SyntaxError) {
    return new OmniError("bad_request", "malformed JSON body", { cause: e });
  }

  const converted = OmniError.from(e);
  if (converted.code === "internal" && !(e instanceof OmniError)) {
    // §9: the 500 message is generic. Whatever the throw actually said is diagnostics, and
    // diagnostics on an unclassified failure is how internals reach a stranger's console.
    return new OmniError("internal", "internal error", { cause: e });
  }
  return converted;
}

interface ZodIssue {
  readonly path?: readonly PropertyKey[];
  readonly message?: string;
}

function asZodError(e: unknown): readonly ZodIssue[] | null {
  if (typeof e !== "object" || e === null) return null;
  const named = (e as { name?: unknown }).name;
  const issues = (e as { issues?: unknown }).issues;
  if (named !== "ZodError" || !Array.isArray(issues)) return null;
  return issues as readonly ZodIssue[];
}

/** Compact and bounded: the field that failed and why, never the value that was sent. */
function zodMessage(issues: readonly ZodIssue[]): string {
  const parts = issues.slice(0, 3).map((issue) => {
    const where = (issue.path ?? []).join(".");
    return where === "" ? (issue.message ?? "invalid") : `${where}: ${issue.message ?? "invalid"}`;
  });
  if (parts.length === 0) return "invalid request";
  const extra = issues.length - parts.length;
  return `${parts.join("; ")}${extra > 0 ? ` (+${extra} more)` : ""}`;
}
