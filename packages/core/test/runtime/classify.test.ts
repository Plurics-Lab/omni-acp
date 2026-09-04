import { describe, expect, it } from "vitest";
import type { AcpErrorDetail, ErrorRule } from "@omni-acp/protocol";
import {
  classifyAcpError,
  classifyProbe,
  verdictImpliesSupport,
} from "../../src/runtime/classify.js";
import { BUILTIN_RUNTIMES } from "../../src/runtime/known.js";
import { exchange } from "./corpus-08.js";

/**
 * WP-E acceptance 1: `classifyProbe` reproduces all five corpus verdicts of §17.4, INCLUDING
 * learning `configId` from `-32602 data.configId._errors`.
 *
 * Every case below is fed the VERBATIM JSON-RPC response line from
 * `docs/research/transcripts/claude-acp-0.73.0/08-set-model-extension.jsonl`, by its request id,
 * so the table cannot drift from the recording it claims to encode.
 */
describe("classifyProbe — the five corpus verdicts (§17.4, corpus 08)", () => {
  it("id 3: -32601 + data.method => not_implemented (session/set_model does not exist here)", () => {
    const { request, response } = exchange(3);
    expect(request["method"]).toBe("session/set_model");
    expect(classifyProbe(response)).toEqual({ kind: "not_implemented", code: -32601 });
  });

  it("id 6: a result => implemented (session/set_mode IS live on the same process — F18)", () => {
    const { request, response } = exchange(6);
    expect(request["method"]).toBe("session/set_mode");
    expect(classifyProbe(response)).toEqual({ kind: "implemented", result: {} });
  });

  it("id 7: -32602 + data.configId._errors => implemented_other_params, and it LEARNS `configId`", () => {
    const { request, response } = exchange(7);
    expect(request["method"]).toBe("session/set_config_option");
    // The probe sent `optionId`; the answer names `configId`. This one line is how the probe
    // learns the parameter's real name rather than being told it by a document (F17).
    expect((request["params"] as Record<string, unknown>)["optionId"]).toBe("mode");
    expect(classifyProbe(response)).toEqual({
      kind: "implemented_other_params",
      code: -32602,
      hints: ["configId"],
    });
  });

  it("id 8: a result => implemented, once the RIGHT param name is used", () => {
    const { request, response } = exchange(8);
    expect((request["params"] as Record<string, unknown>)["configId"]).toBe("model");
    const verdict = classifyProbe(response);
    expect(verdict.kind).toBe("implemented");
  });

  it("id 9: -32603 + data.details => implemented_bad_value, NOT a generic internal error", () => {
    const { response } = exchange(9);
    expect(classifyProbe(response)).toEqual({
      kind: "implemented_bad_value",
      code: -32603,
      details: "Invalid value for config option model: no-such-model-xyz",
    });
  });

  it("id 13: the control method is -32601, which is what makes the other verdicts readable", () => {
    const { request, response } = exchange(13);
    expect(request["method"]).toBe("omni/definitely_unknown_method");
    expect(classifyProbe(response)).toEqual({ kind: "not_implemented", code: -32601 });
  });

  it("classifies by CODE and a POINTER, never by the message text (F17)", () => {
    const { response } = exchange(3);
    const message = (response as { error: { message: string } }).error.message;
    // The real message carries embedded quotes and is not a stable contract. Prove the
    // classifier does not depend on it by changing it to something absurd.
    const mangled = {
      error: { code: -32601, message: "☃", data: { method: "session/set_model" } },
    };
    expect(message).toBe('"Method not found": session/set_model');
    expect(classifyProbe(mangled)).toEqual(classifyProbe(response));
  });
});

describe("classifyProbe — total, and honest about what it cannot read", () => {
  it("an unrecognised error code is `error`: recorded, not interpreted", () => {
    expect(classifyProbe({ code: -32002, message: "Resource not found: abc" })).toEqual({
      kind: "error",
      code: -32002,
      message: "Resource not found: abc",
    });
  });

  it("-32603 WITHOUT data.details stays an unclassified error, not implemented_bad_value", () => {
    // §17.3: a wrong VALUE and a genuine internal error share -32603 and are separated only by
    // the pointer. Reading the second as the first would report a crashed agent as a live method.
    expect(classifyProbe({ code: -32603, message: "Internal error" })).toEqual({
      kind: "error",
      code: -32603,
      message: "Internal error",
    });
  });

  it("-32602 with nothing to learn still proves the method EXISTS, with an empty hint list", () => {
    expect(classifyProbe({ code: -32602, message: "Invalid params" })).toEqual({
      kind: "implemented_other_params",
      code: -32602,
      hints: [],
    });
  });

  it("skips the object's own top-level `_errors`, which names no parameter", () => {
    const verdict = classifyProbe({
      code: -32602,
      message: "Invalid params",
      data: { _errors: ["bad"], sessionId: { _errors: ["required"] } },
    });
    expect(verdict).toEqual({
      kind: "implemented_other_params",
      code: -32602,
      hints: ["sessionId"],
    });
  });

  it("ignores a field whose `_errors` is empty — that field was accepted", () => {
    const verdict = classifyProbe({
      code: -32602,
      message: "Invalid params",
      data: { _errors: [], sessionId: { _errors: [] }, configId: { _errors: ["required"] } },
    });
    expect(verdict).toEqual({
      kind: "implemented_other_params",
      code: -32602,
      hints: ["configId"],
    });
  });

  it("reads a rejected SDK request (an Error with a numeric code) the same as a wire line", () => {
    const thrown = Object.assign(new Error('"Method not found": session/set_options'), {
      code: -32601,
      data: { method: "session/set_options" },
    });
    expect(classifyProbe(thrown)).toEqual({ kind: "not_implemented", code: -32601 });
  });

  it("a plain result value and a {result} response classify identically", () => {
    expect(classifyProbe({ result: { sessions: [] } })).toEqual({
      kind: "implemented",
      result: { sessions: [] },
    });
    expect(classifyProbe({ sessions: [] })).toEqual({
      kind: "implemented",
      result: { sessions: [] },
    });
  });

  it("never treats a `{result}` response as an error, even when the result carries a `code`", () => {
    expect(classifyProbe({ result: { code: -32601, message: "not an error" } })).toEqual({
      kind: "implemented",
      result: { code: -32601, message: "not an error" },
    });
  });

  it("verdictImpliesSupport: three verdicts prove existence, three do not", () => {
    expect(verdictImpliesSupport({ kind: "implemented", result: {} })).toBe(true);
    expect(
      verdictImpliesSupport({ kind: "implemented_other_params", code: -32602, hints: [] }),
    ).toBe(true);
    expect(
      verdictImpliesSupport({ kind: "implemented_bad_value", code: -32603, details: "x" }),
    ).toBe(true);
    expect(verdictImpliesSupport({ kind: "not_implemented", code: -32601 })).toBe(false);
    expect(verdictImpliesSupport({ kind: "error", code: -1, message: "" })).toBe(false);
    expect(verdictImpliesSupport({ kind: "skipped", reason: "shallow" })).toBe(false);
  });
});

/** The claude-acp builtin's own two rules, applied to the errors that produced them. */
const CLAUDE_RULES = BUILTIN_RUNTIMES[0]!.descriptor.errorRules;

describe("classifyAcpError — a descriptor's rules, first match wins (§17.3)", () => {
  const detail = (code: number, message: string, data?: unknown): AcpErrorDetail =>
    ({ code, message, ...(data === undefined ? {} : { data }) }) as AcpErrorDetail;

  it("separates a wrong config VALUE from a genuine internal error, which share -32603 (F17)", () => {
    const badValue = detail(-32603, "Internal error", {
      details: "Invalid value for config option model: no-such-model-xyz",
    });
    const genuine = detail(-32603, "Internal error", { details: "the agent fell over" });
    expect(classifyAcpError(CLAUDE_RULES, badValue)).toEqual({ kind: "bad_request" });
    expect(classifyAcpError(CLAUDE_RULES, genuine)).toEqual({ kind: "unclassified" });
  });

  it("reports the unsupported METHOD from data.method, not from the message", () => {
    const e = detail(-32601, '"Method not found": session/set_model', {
      method: "session/set_model",
    });
    expect(classifyAcpError(CLAUDE_RULES, e)).toEqual({
      kind: "unsupported_method",
      method: "session/set_model",
    });
  });

  it("a -32601 with no data.method is unclassified rather than a fabricated method name", () => {
    expect(classifyAcpError(CLAUDE_RULES, detail(-32601, "Method not found"))).toEqual({
      kind: "unclassified",
    });
  });

  it("has NO rule for the -32002 cwd mismatch — ruling M1-R6 gives that to classifyResume", () => {
    const e = detail(-32002, "Resource not found: 9d0e-…");
    expect(classifyAcpError(CLAUDE_RULES, e)).toEqual({ kind: "unclassified" });
  });

  it("never throws: an unmatched error is a diagnosis", () => {
    expect(classifyAcpError([], detail(-1, "who knows"))).toEqual({ kind: "unclassified" });
  });

  it("first match wins, so an earlier rule shadows a later one", () => {
    const rules: readonly ErrorRule[] = [
      { id: "first", code: -32000, classify: "bad_request" },
      { id: "second", code: -32000, classify: "agent_error" },
    ];
    expect(classifyAcpError(rules, detail(-32000, "x"))).toEqual({ kind: "bad_request" });
  });

  it("a `dataMatches` with no pointer never matches — a typo must not become a catch-all", () => {
    const rules: readonly ErrorRule[] = [
      { id: "typo", code: -32000, dataMatches: "anything", classify: "agent_error" },
    ];
    expect(classifyAcpError(rules, detail(-32000, "x", { details: "anything" }))).toEqual({
      kind: "unclassified",
    });
  });

  it("a malformed regex in operator config does not take the daemon down; it simply misses", () => {
    const rules: readonly ErrorRule[] = [
      {
        id: "bad-re",
        code: -32000,
        dataPointer: "/details",
        dataMatches: "([",
        classify: "agent_error",
      },
    ];
    expect(classifyAcpError(rules, detail(-32000, "x", { details: "[" }))).toEqual({
      kind: "unclassified",
    });
  });

  it("maps the two resume classifications without inventing a hint the rule never carried", () => {
    const rules: readonly ErrorRule[] = [
      { id: "gone", code: -32001, classify: "resume_permanent" },
      { id: "busy", code: -32029, classify: "resume_transient" },
    ];
    expect(classifyAcpError(rules, detail(-32001, "gone"))).toEqual({
      kind: "resume",
      outcome: "rejected_permanent",
      hint: "unclassified",
    });
    expect(classifyAcpError(rules, detail(-32029, "busy"))).toEqual({
      kind: "resume",
      outcome: "rejected_transient",
      hint: "unclassified",
    });
  });

  it("`messageMatches` works for a runtime that leaves us nothing else (and is discouraged)", () => {
    const rules: readonly ErrorRule[] = [
      { id: "last-resort", messageMatches: "^rate limit", classify: "agent_error" },
    ];
    expect(classifyAcpError(rules, detail(-1, "rate limit exceeded"))).toEqual({
      kind: "agent_error",
    });
    expect(classifyAcpError(rules, detail(-1, "something else"))).toEqual({ kind: "unclassified" });
  });
});
