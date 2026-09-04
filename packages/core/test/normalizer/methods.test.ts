import { describe, expect, it } from "vitest";
import { createNormalizer } from "@omni-acp/core";
import { fakeRuntime } from "@omni-acp/testkit";
import { transcriptError, transcriptResult } from "./support/corpus-facts.js";
import type { OutboundCall } from "@omni-acp/protocol";
import { mapCapabilities } from "../../src/normalizer/map/capabilities.js";
import { classifyError } from "../../src/normalizer/map/errors.js";
import { mapRequest, resolveInboundMethod, untagIds } from "../../src/normalizer/map/methods.js";
import { claudeAcpDescriptor } from "./support/claude-acp.js";

/**
 * CONTRACTS.md §12.3 rows 19-28 and §17.3: the client→agent half of the map.
 *
 * F18 is what shapes every case here: on ONE claude-acp process `session/set_mode` and
 * `session/set_config_option` are both live while `session/set_model` is `-32601`. So a
 * capability has a PREFERENCE ORDER over spellings, not a name; a `-32601` retires one spelling
 * for the life of the process and never further; and nothing is ever classified from message
 * text, because the observed message is `"\"Method not found\": session/set_model"` — quotes
 * inside quotes — while `data.method` carries the same fact in a field.
 */

const D = claudeAcpDescriptor();
const call = (
  method: string,
  params: Record<string, unknown> = {},
  unsupported: ReadonlySet<string> = new Set(),
): OutboundCall => mapRequest(method, params, D, unsupported);

describe("§17.3 — preference order over spellings", () => {
  it("picks the FIRST spelling not already known unsupported", () => {
    expect(call("session/set_config_option", { configId: "model", value: "sonnet" })).toEqual({
      method: "session/set_config_option",
      params: { configId: "model", value: "sonnet" },
      spelling: "session/set_config_option",
      onFailure: "fail",
    });
  });

  it("falls to the NEXT spelling once the first is retired, and renames its params (row 25)", () => {
    const out = call(
      "session/set_config_option",
      { configId: "mode", value: "acceptEdits" },
      new Set(["session/set_config_option"]),
    );
    expect(out).toEqual({
      method: "session/set_mode",
      params: { modeId: "acceptEdits" },
      spelling: "session/set_mode",
      onFailure: "fail",
    });
  });

  it("row 26: `set_model` is a SPELLING, and its params are renamed when it is the one in force", () => {
    const out = call(
      "session/set_config_option",
      { configId: "model", value: "sonnet" },
      new Set(["session/set_config_option", "session/set_mode"]),
    );
    expect(out).toEqual({
      method: "session/set_model",
      params: { modelId: "sonnet" },
      spelling: "session/set_model",
      onFailure: "fail",
    });
  });

  it("reports `spelling: null` once every spelling is exhausted, rather than guessing a name", () => {
    const out = call(
      "session/set_config_option",
      { configId: "model", value: "x" },
      new Set(["session/set_config_option", "session/set_mode", "session/set_model"]),
    );
    expect(out.spelling).toBeNull();
    expect(out.onFailure).toBe("fail");
  });

  it("row 24: `session/resume` -> `session/load` DROPS `replayFrom`, which v1 has no field for", () => {
    expect(
      call(
        "session/resume",
        { sessionId: "s", cwd: "/tmp/ws", mcpServers: [], replayFrom: { type: "beginning" } },
        new Set(["session/resume"]),
      ),
    ).toEqual({
      method: "session/load",
      params: { sessionId: "s", cwd: "/tmp/ws", mcpServers: [] },
      spelling: "session/load",
      onFailure: "fail",
    });
  });

  it("row 26b: `onFailure` is per capability — `setConfig` fails, `setOptions` only WARNS", () => {
    // DESIGN §6.2, review R2: a caller asked for a model and did not get one, versus an agent
    // that has done nothing wrong by not implementing an extension we offered.
    expect(call("session/set_config_option").onFailure).toBe("fail");
    expect(call("session/set_options", { anything: 1 }).onFailure).toBe("warn");
    expect(call("session/list").onFailure).toBe("fail");
    expect(call("session/close", { sessionId: "s" }).onFailure).toBe("fail");
  });

  it("a method that is not a capability keeps its one name", () => {
    for (const method of ["session/new", "session/prompt", "session/cancel"]) {
      const out = call(method, { sessionId: "s" });
      expect(out.method).toBe(method);
      expect(out.spelling).toBe(method);
    }
  });

  it("row 23: `auth/login` / `auth/logout` are UNVERIFIED, so an unconfigured descriptor says so", () => {
    // claude-acp advertises `auth: {logout:{}}` and `authMethods: []`, and the corpus never
    // exercises it. `spelling: null` is the honest answer, and the compat suite refuses to
    // assert the row at all.
    expect(call("auth/login", { methodId: "oauth" }).spelling).toBeNull();
    expect(call("auth/logout").spelling).toBeNull();
  });

  it("…and a descriptor that DOES declare them resolves to the v1 spelling", () => {
    const withAuth = fakeRuntime({
      prefer: {
        authLogin: { spellings: ["auth/login", "authenticate"], onFailure: "fail" },
        authLogout: { spellings: ["auth/logout", "logout"], onFailure: "fail" },
      },
    });
    expect(
      mapRequest("auth/login", { methodId: "oauth" }, withAuth, new Set(["auth/login"])),
    ).toEqual({
      method: "authenticate",
      params: { methodId: "oauth" },
      spelling: "authenticate",
      onFailure: "fail",
    });
  });
});

describe("§12.3 row 19 — `initialize`'s outbound rename", () => {
  it("v2 `{capabilities, info}` becomes v1 `{clientCapabilities, clientInfo}`", () => {
    expect(
      call("initialize", { protocolVersion: 1, capabilities: {}, info: { name: "omni-acp" } }),
    ).toEqual({
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "omni-acp" } },
      spelling: "initialize",
      onFailure: "fail",
    });
  });

  it("D3's empty capability set survives the rename, because v2 has no `fs`/`terminal` keys", () => {
    const params = (call("initialize", { protocolVersion: 1, capabilities: {} }) as OutboundCall)
      .params;
    expect(params["clientCapabilities"]).toEqual({});
  });
});

describe("§12.3 row 22 — an `McpServer` without a `type` gets one", () => {
  it("`command` implies stdio and `url` implies http", () => {
    const out = call("session/new", {
      cwd: "/tmp/ws",
      mcpServers: [
        { name: "a", command: "node", args: [] },
        { name: "b", url: "https://example.invalid/mcp" },
      ],
    });
    expect(out.params["mcpServers"]).toEqual([
      { name: "a", command: "node", args: [], type: "stdio" },
      { name: "b", url: "https://example.invalid/mcp", type: "http" },
    ]);
  });

  it("leaves an existing `type` alone, and refuses to classify a server it cannot read", () => {
    const out = call("session/new", {
      mcpServers: [{ name: "a", command: "node", type: "http" }, { name: "b" }, 7],
    });
    expect(out.params["mcpServers"]).toEqual([
      { name: "a", command: "node", type: "http" },
      { name: "b" },
      7,
    ]);
  });

  it("is UNREACHABLE from the wire in M1 — `mcpServers` is always `[]`", () => {
    // Implemented and unit-tested, gated behind M2's presets (§2.3). DESIGN §8 calls
    // `mcpServers` the highest-risk attack surface, and shipping it half-tested would be worse.
    expect(call("session/new", { cwd: "/tmp/ws", mcpServers: [] }).params["mcpServers"]).toEqual(
      [],
    );
  });
});

describe("§12.3 row 27 — v2's `{type:'id', value}` tag is DROPPED outbound", () => {
  it("drops the tag and keeps `{value}`, recursively, and only on that exact shape", () => {
    expect(untagIds({ type: "id", value: "s1" })).toEqual({ value: "s1" });
    expect(
      untagIds({
        a: [
          { type: "id", value: 1 },
          { type: "id", value: 2 },
        ],
      }),
    ).toEqual({
      a: [{ value: 1 }, { value: 2 }],
    });
    // A vendor object that merely HAS a `type` is untouched: the rule is the two-key shape.
    expect(untagIds({ type: "id", value: 1, extra: 2 })).toEqual({
      type: "id",
      value: 1,
      extra: 2,
    });
    expect(untagIds({ type: "text", value: "x" })).toEqual({ type: "text", value: "x" });
  });

  it("applies through `mapRequest`, so v1's untagged arm is what reaches the wire", () => {
    expect(call("session/prompt", { sessionId: { type: "id", value: "s1" } }).params).toEqual({
      sessionId: { value: "s1" },
    });
  });
});

describe("§12.3 row 18b — inbound method aliases", () => {
  it("renames only a REGISTERED spelling, and `{}` is the table for every agent M1 knows", () => {
    expect(D.inboundAliases).toEqual({});
    expect(resolveInboundMethod("session/notification", D)).toBe("session/notification");

    const aliased = fakeRuntime({ inboundAliases: { "session/notification": "session/update" } });
    expect(resolveInboundMethod("session/notification", aliased)).toBe("session/update");
    // An UNREGISTERED method keeps §7.6's `-32601`, so a typo cannot silently swallow updates.
    expect(resolveInboundMethod("session/notifcation", aliased)).toBe("session/notifcation");
  });
});

describe("§17.3 — `noteUnsupported` learns per PROCESS", () => {
  it("retires a spelling for the life of the normalizer and never beyond it", () => {
    const a = createNormalizer({ quietMs: 250, hardMs: 5_000, descriptor: D });
    expect(a.mapRequest("session/set_config_option", {}).spelling).toBe(
      "session/set_config_option",
    );
    a.noteUnsupported("session/set_config_option");
    expect(a.mapRequest("session/set_config_option", {}).spelling).toBe("session/set_mode");

    // A second worker — a second process — starts from the descriptor again: a version bump may
    // have added the method back, and a persisted "unsupported" would be a permanent downgrade.
    const b = createNormalizer({ quietMs: 250, hardMs: 5_000, descriptor: D });
    expect(b.mapRequest("session/set_config_option", {}).spelling).toBe(
      "session/set_config_option",
    );
  });
});

describe("§17.3 — `classifyError` keys on a CODE and a JSON POINTER, never on text", () => {
  it("classifies the RECORDED `-32601` as unsupported, and names the method from `data.method`", () => {
    // Transcript 08's `session/set_model`, verbatim: the message is
    // `"\"Method not found\": session/set_model"` and is not a contract; `data.method` is.
    const recorded = transcriptError("08-set-model-extension", 4) as {
      code: number;
      message: string;
      data: { method: string };
    };
    expect(recorded.code).toBe(-32601);
    expect(recorded.data.method).toBe("session/set_model");
    expect(classifyError(recorded, D)).toEqual({
      kind: "unsupported_method",
      method: "session/set_model",
    });
  });

  it("classifies the RECORDED bad-value `-32603` as `bad_request`, from `data.details`", () => {
    // F17: a wrong VALUE and a genuine internal error share `-32603` and are separated only by
    // the pointer, which is why the descriptor carries a rule rather than the code carrying a
    // meaning.
    const rules = D.errorRules.filter((r) => r.id === "bad-config-value");
    expect(rules).toHaveLength(1);
    expect(
      classifyError(
        {
          code: -32603,
          message: "Internal error",
          data: { details: "Invalid value for config option model: no-such-model-xyz" },
        },
        D,
      ),
    ).toEqual({ kind: "bad_request" });
  });

  it("…and a GENUINE `-32603` with the same code is NOT a bad request", () => {
    expect(classifyError({ code: -32603, message: "Internal error" }, D)).toEqual({
      kind: "unclassified",
    });
    expect(
      classifyError({ code: -32603, message: "Internal error", data: { details: "disk full" } }, D),
    ).toEqual({ kind: "unclassified" });
  });

  it("NEVER throws: a bad regex in an operator's overlay classifies rather than crashing", () => {
    const broken = fakeRuntime({
      errorRules: [
        { id: "bad", code: -32000, dataPointer: "/x", dataMatches: "([", classify: "agent_error" },
      ],
    });
    expect(() =>
      classifyError({ code: -32000, message: "x", data: { x: "y" } }, broken),
    ).not.toThrow();
    expect(classifyError({ code: -32000, message: "x", data: { x: "y" } }, broken)).toEqual({
      kind: "unclassified",
    });
  });

  it("`unknownMethodErrorCode` is a DESCRIPTOR field, so a runtime that answers differently says so", () => {
    const odd = fakeRuntime({
      quirks: { ...fakeRuntime().quirks, unknownMethodErrorCode: -32000 },
    });
    expect(classifyError({ code: -32000, message: "nope" }, odd)).toEqual({
      kind: "unsupported_method",
      method: null,
    });
    // …and the JSON-RPC default is no longer special-cased for that runtime.
    expect(classifyError({ code: -32601, message: "nope" }, odd)).toEqual({ kind: "unclassified" });
  });

  it("reports `method: null` rather than parsing the method out of the message", () => {
    expect(classifyError({ code: -32601, message: '"Method not found": session/x' }, D)).toEqual({
      kind: "unsupported_method",
      method: null,
    });
  });
});

describe("§12.3 rows 20-21 — the InitializeResponse, mapped per field", () => {
  const INITIALIZE = transcriptResult("01-plain-answer", 1);
  const SESSION = transcriptResult("01-plain-answer", 2);

  it("reads the RECORDED handshake: v1 field names, v2 field names, or both", () => {
    const caps = mapCapabilities(INITIALIZE, SESSION, D);
    expect(caps.protocolVersion).toBe(1);
    expect(caps.loadSession).toBe(true);
    expect(caps.supportsSessionClose).toBe(true);
    expect(caps.supportsSessionList).toBe(true);
    // F18: `session/resume` is advertised AND live, so the descriptor's first spelling wins.
    expect(caps.resume).toEqual({
      method: "session/resume",
      replayFrom: true,
      requiresSameCwd: true,
    });
  });

  it("row 21: `promptCapabilities: {image: true}` becomes `{image: {}}`, absent stays absent", () => {
    const caps = mapCapabilities(INITIALIZE, SESSION, D);
    expect(caps.promptCapabilities).toEqual({ image: {}, embeddedContext: {} });
  });

  it("row 21 is IDEMPOTENT on a v2 agent that already sends objects", () => {
    const v2 = {
      protocolVersion: 2,
      capabilities: { session: { prompt: { image: {}, audio: {} }, load: {}, close: {} } },
    };
    const caps = mapCapabilities(v2, null, D);
    expect(caps.protocolVersion).toBe(2);
    expect(caps.promptCapabilities).toEqual({ image: {}, audio: {} });
    expect(caps.loadSession).toBe(true);
    expect(caps.supportsSessionClose).toBe(true);
  });

  it("`false` and absent are OMITTED — there is no v2 spelling for 'explicitly unsupported'", () => {
    const caps = mapCapabilities(
      { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } },
      null,
      D,
    );
    expect(caps.promptCapabilities).toEqual({});
  });

  it("captures `modes` and `configOptions` off the session body, which row 11 cannot work without", () => {
    const caps = mapCapabilities(INITIALIZE, SESSION, D);
    expect((caps.modes as { currentModeId: string }).currentModeId).toBe("default");
    expect(Array.isArray(caps.configOptions)).toBe(true);
    expect((caps.configOptions ?? []).length).toBeGreaterThan(0);
  });

  it("resume is `null` when the agent advertised NO spelling — M1-R15's one-way door", () => {
    // Hibernating a worker you can never wake turns a healthy worker into a guaranteed 422 on a
    // timer, so `method: null` is what `whenNotResumable: "keep"` keys on.
    const caps = mapCapabilities(
      { protocolVersion: 1, agentCapabilities: { loadSession: false } },
      null,
      D,
    );
    expect(caps.resume.method).toBeNull();
    expect(caps.resume.replayFrom).toBe(false);
  });

  it("`raw` is the agent's own capability object, never reshaped", () => {
    const caps = mapCapabilities(INITIALIZE, SESSION, D);
    expect(caps.raw).toBe((INITIALIZE as { agentCapabilities: unknown }).agentCapabilities);
  });
});
