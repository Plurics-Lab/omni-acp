import {
  type AcpErrorDetail,
  type ErrorClass,
  type ErrorRule,
  type MethodVerdict,
} from "@omni-acp/protocol";
import { readPointer } from "./extensions.js";

/** A JSON-RPC error as it reaches us: from a rejected SDK request, or straight off the wire. */
interface JsonRpcErrorish {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recognise a JSON-RPC error in any of the three shapes one actually arrives in.
 *
 * Structural rather than `instanceof`: the SDK's `RequestError` is one realm's class, a raw
 * transcript line is a plain object, and a table test feeds the bytes the corpus recorded. All
 * three carry the same two fields, and a check that only understood one of them would make the
 * corpus table untestable against the code that runs in production.
 */
function asJsonRpcError(e: unknown): JsonRpcErrorish | null {
  if (!isRecord(e) && !(e instanceof Error)) return null;
  const source = e as Record<string, unknown>;

  // A whole JSON-RPC response: `{jsonrpc, id, error}` — what a transcript line holds.
  const nested = source["error"];
  if (isRecord(nested) && typeof nested["code"] === "number") {
    return {
      code: nested["code"],
      message: typeof nested["message"] === "string" ? nested["message"] : "",
      ...(nested["data"] === undefined ? {} : { data: nested["data"] }),
    };
  }

  // A `{result: …}` response is never an error, even if the result happens to carry a `code`.
  if ("result" in source) return null;

  if (typeof source["code"] !== "number") return null;
  if (typeof source["message"] !== "string") return null;
  return {
    code: source["code"],
    message: source["message"],
    ...(source["data"] === undefined ? {} : { data: source["data"] }),
  };
}

/**
 * zod's `-32602` payload names the offending FIELD: `{_errors: [], configId: {_errors: [...]}}`.
 *
 * The hint is every key whose value carries a non-empty `_errors` array — the top-level
 * `_errors` (the object's own, always `[]` here) is skipped, because it says nothing about a
 * parameter name. This is the single line that turns "the method exists" into "the method exists
 * and the parameter is called `configId`" (F17).
 */
function paramHints(data: unknown): string[] {
  if (!isRecord(data)) return [];
  const hints: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === "_errors") continue;
    if (!isRecord(value)) continue;
    const errors = value["_errors"];
    if (Array.isArray(errors) && errors.length > 0) hints.push(key);
  }
  return hints;
}

/**
 * Classify one probe answer by CODE + a JSON pointer into `data` — never by message text (F17,
 * CONTRACTS.md §17.4). `-32602` with `data.<field>._errors` is the row that TEACHES the probe
 * the parameter is `configId` and not `optionId`; `-32603` with `data.details` is "implemented,
 * value rejected", which `code` alone cannot separate from a genuine internal error.
 *
 * TOTAL: every input produces a verdict, and an answer this table does not recognise is
 * `{kind:"error"}` — recorded, not interpreted — rather than a throw. A probe that crashes on an
 * unexpected answer teaches nothing about the agent that produced it.
 *
 * Owned by M1-WP-E.
 */
export function classifyProbe(e: unknown): MethodVerdict {
  const error = asJsonRpcError(e);
  if (error === null) {
    // A success. `{result: X}` (a whole response) and a bare result are both accepted so that a
    // transcript line and a resolved SDK promise classify identically.
    const result = isRecord(e) && "result" in e ? e["result"] : e;
    return { kind: "implemented", result };
  }

  if (error.code === -32601) return { kind: "not_implemented", code: -32601 };

  if (error.code === -32602) {
    const hints = paramHints(error.data);
    if (hints.length > 0) {
      return { kind: "implemented_other_params", code: -32602, hints };
    }
    // `-32602` with nothing to learn from: the method still EXISTS (invalid params is not
    // "method not found"), but we learned no field name, so we say so with an empty hint list.
    return { kind: "implemented_other_params", code: -32602, hints: [] };
  }

  if (error.code === -32603) {
    const details = readPointer(error.data, "/details");
    if (typeof details === "string") {
      return { kind: "implemented_bad_value", code: -32603, details };
    }
  }

  return { kind: "error", code: error.code, message: error.message };
}

/** Did this verdict prove the method EXISTS on the other end? */
export function verdictImpliesSupport(v: MethodVerdict): boolean {
  return (
    v.kind === "implemented" ||
    v.kind === "implemented_other_params" ||
    v.kind === "implemented_bad_value"
  );
}

/**
 * Apply a descriptor's `errorRules`, in order, to a JSON-RPC error. NEVER throws — an
 * unmatched error is `{kind:"unclassified"}`, which is a diagnosis, not a crash.
 *
 * A rule matches when EVERY predicate it states holds; a rule that states none matches
 * everything, which is how a runtime writes a catch-all last. `messageMatches` exists for
 * runtimes that leave us nothing else and is discouraged in prose and in review — the observed
 * claude-acp message is `"\"Method not found\": session/set_model"`, with embedded quotes, and is
 * not a stable contract.
 *
 * Owned by M1-WP-E.
 */
export function classifyAcpError(rules: readonly ErrorRule[], e: AcpErrorDetail): ErrorClass {
  for (const rule of rules) {
    if (!ruleMatches(rule, e)) continue;
    switch (rule.classify) {
      case "bad_request":
        return { kind: "bad_request" };
      case "agent_error":
        return { kind: "agent_error" };
      case "unsupported_method": {
        const method = readPointer(e.data, "/method");
        return { kind: "unsupported_method", method: typeof method === "string" ? method : null };
      }
      case "resume_permanent":
        // The rule table has no hint column, and inventing one here would assert evidence the
        // rule never carried. `classifyResume` (M1-WP-C, §15.4) is the authority on hints; this
        // says only what the operator's rule said.
        return { kind: "resume", outcome: "rejected_permanent", hint: "unclassified" };
      case "resume_transient":
        return { kind: "resume", outcome: "rejected_transient", hint: "unclassified" };
    }
  }
  return { kind: "unclassified" };
}

function ruleMatches(rule: ErrorRule, e: AcpErrorDetail): boolean {
  if (rule.code !== undefined && rule.code !== e.code) return false;

  if (rule.dataPointer !== undefined) {
    const at = readPointer(e.data, rule.dataPointer);
    if (at === undefined) return false;
    if (rule.dataMatches !== undefined) {
      if (typeof at !== "string") return false;
      if (!safeTest(rule.dataMatches, at)) return false;
    }
  } else if (rule.dataMatches !== undefined) {
    // A `dataMatches` with no pointer has nothing to match against; treat it as unmatched
    // rather than silently matching everything, which would make a typo'd rule a catch-all.
    return false;
  }

  if (rule.messageMatches !== undefined && !safeTest(rule.messageMatches, e.message)) return false;

  return true;
}

/**
 * A descriptor is operator input, and an unanchored or malformed pattern must not take the
 * daemon down at classification time — this function is on the path of every agent error.
 * A bad pattern simply does not match, which is the conservative answer.
 */
function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return false;
  }
}
