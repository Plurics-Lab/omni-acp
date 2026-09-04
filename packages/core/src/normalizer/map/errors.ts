import type { AcpErrorDetail, ErrorClass, RuntimeDescriptor } from "@omni-acp/protocol";
import { resolvePointer, str } from "./json.js";

/**
 * Classify a JSON-RPC error with the DESCRIPTOR's rules (CONTRACTS.md §17.3).
 *
 * The rule that shapes this file: **classification keys on a CODE and a JSON POINTER into
 * `data`, never on message text.** F17 shows why it is not a style preference — the observed
 * unknown-method message is `"\"Method not found\": session/set_model"`, with embedded quotes,
 * while `data.method` carries the same information in a field; and a wrong config VALUE and a
 * genuine internal error share `-32603` and are separated only by `data.details`. Text is not a
 * contract, and the `no-agent-prose` guard (§13.4) fails the build on a source file outside the
 * descriptor dialect module that matches one of the recorded English strings.
 *
 * `ErrorRule.messageMatches` exists for a runtime that leaves us nothing else, is discouraged in
 * §5.1's own prose, and is therefore tried LAST — after every code-and-pointer rule has declined.
 *
 * NEVER THROWS: a bad regex in an operator's overlay classifies as `unclassified` rather than
 * taking down the call it was asked about.
 *
 * Owned by M1-WP-B.
 */
export function classifyError(e: AcpErrorDetail, descriptor: RuntimeDescriptor): ErrorClass {
  // Descriptor rules first, in declaration order: an overlay exists to win.
  for (const rule of descriptor.errorRules) {
    if (!matches(rule, e)) continue;
    switch (rule.classify) {
      case "bad_request":
        return { kind: "bad_request" };
      case "agent_error":
        return { kind: "agent_error" };
      case "unsupported_method":
        return { kind: "unsupported_method", method: methodOf(e) };
      case "resume_permanent":
        return { kind: "resume", outcome: "rejected_permanent", hint: "not_found" };
      case "resume_transient":
        return { kind: "resume", outcome: "rejected_transient", hint: "rate_limited" };
    }
  }

  // The one built-in, and it is still descriptor-driven: `unknownMethodErrorCode` is a quirk
  // field, defaulting to JSON-RPC's own `-32601`, so a runtime that answers something else says
  // so in its descriptor rather than in a branch here.
  if (e.code === descriptor.quirks.unknownMethodErrorCode) {
    return { kind: "unsupported_method", method: methodOf(e) };
  }

  // JSON-RPC's own reserved range, which is a contract rather than a vendor convention.
  if (e.code === -32600 || e.code === -32602 || e.code === -32700) return { kind: "bad_request" };

  return { kind: "unclassified" };
}

/**
 * `data.method` — the field, not the message.
 *
 * The observed message embeds the method in quotes inside quotes; parsing it would be exactly
 * the text-matching this module exists to avoid, so an error without the field reports `null`
 * and the caller says "we do not know which method" instead of guessing.
 */
function methodOf(e: AcpErrorDetail): string | null {
  return str(resolvePointer(e.data, "/method"));
}

function matches(rule: RuntimeDescriptor["errorRules"][number], e: AcpErrorDetail): boolean {
  if (rule.code !== undefined && rule.code !== e.code) return false;

  if (rule.dataPointer !== undefined) {
    const value = resolvePointer(e.data, rule.dataPointer);
    if (value === undefined) return false;
    if (rule.dataMatches !== undefined && !test(rule.dataMatches, stringify(value))) return false;
  } else if (rule.dataMatches !== undefined) {
    // A `dataMatches` with no pointer has nothing to match against: a rule that silently matched
    // everything would be worse than one that matches nothing.
    return false;
  }

  if (rule.messageMatches !== undefined && !test(rule.messageMatches, e.message)) return false;

  // A rule with no code, no pointer and no message matcher matches everything, which is a
  // legitimate operator catch-all placed last.
  return true;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? null);
}

function test(pattern: string, subject: string): boolean {
  try {
    return new RegExp(pattern).test(subject);
  } catch {
    // An unparseable pattern in a config overlay must not be able to throw out of a classifier
    // whose whole job is to keep a failure legible.
    return false;
  }
}
