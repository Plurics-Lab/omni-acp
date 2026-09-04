import { describe, expect, it } from "vitest";
import {
  OmniError,
  RuntimeOverlay,
  type ProbeSummary,
  type RuntimeDescriptor,
} from "@omni-acp/protocol";
import { assertDescriptorLegal } from "../../src/runtime/descriptor.js";
import { BUILTIN_RUNTIMES, DEFAULT_V1_PROFILE } from "../../src/runtime/known.js";
import { resolveDescriptor } from "../../src/runtime/merge.js";

const CLAUDE = BUILTIN_RUNTIMES[0]!.descriptor;

/** Parse an overlay the way the config loader does, so the tests exercise the real shape. */
const overlay = (o: unknown): RuntimeOverlay => RuntimeOverlay.parse(o);
const EMPTY = overlay({});

const probe = (o: Partial<ProbeSummary> = {}): ProbeSummary => ({
  at: "2026-09-04T00:00:00.000Z",
  agentId: "claude",
  descriptorFingerprint: "f".repeat(64),
  protocolVersion: 1,
  agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.73.0" },
  capabilities: {},
  unsupportedMethods: [],
  supportedMethods: [],
  resumeMethod: null,
  learnedParams: {},
  timings: {},
  ...o,
});

/**
 * WP-E acceptance 4, first half: `resolveDescriptor`'s builtin ⊕ config ⊕ probe merge is
 * TABLE-TESTED. Each row states which layers ran and what the merged descriptor must say.
 */
describe("resolveDescriptor — builtin ⊕ config ⊕ probe (§17.2)", () => {
  it("no builtin, no overlay, no probe ⇒ DEFAULT_V1_PROFILE, source `builtin`", () => {
    const d = resolveDescriptor(null, EMPTY, null);
    expect(d).toEqual({ ...DEFAULT_V1_PROFILE, source: "builtin" });
  });

  it("a brand-new agent works with NO descriptor at all — every quirk is `absent`", () => {
    const d = resolveDescriptor(null, EMPTY, null);
    expect(d.quirks).toEqual(DEFAULT_V1_PROFILE.quirks);
    expect(d.updates).toEqual({});
    expect(d.extensions).toEqual({});
    expect(d.errorRules).toEqual([]);
  });

  describe("source records WHICH LAYERS RAN", () => {
    const cases: readonly {
      name: string;
      builtin: RuntimeDescriptor | null;
      overlay: RuntimeOverlay;
      probe: ProbeSummary | null;
      source: RuntimeDescriptor["source"];
    }[] = [
      { name: "none", builtin: null, overlay: EMPTY, probe: null, source: "builtin" },
      { name: "builtin only", builtin: CLAUDE, overlay: EMPTY, probe: null, source: "builtin" },
      {
        name: "config only",
        builtin: null,
        overlay: overlay({ quirks: { loadReturnsBody: true } }),
        probe: null,
        source: "config",
      },
      { name: "probe only", builtin: null, overlay: EMPTY, probe: probe(), source: "probe" },
      {
        name: "builtin + config",
        builtin: CLAUDE,
        overlay: overlay({ quirks: { loadReturnsBody: false } }),
        probe: null,
        source: "merged",
      },
      {
        name: "builtin + probe",
        builtin: CLAUDE,
        overlay: EMPTY,
        probe: probe(),
        source: "merged",
      },
      {
        name: "all three",
        builtin: CLAUDE,
        overlay: overlay({ budgets: { turnMs: 1_000 } }),
        probe: probe(),
        source: "merged",
      },
    ];
    for (const row of cases) {
      it(`${row.name} ⇒ source "${row.source}"`, () => {
        expect(resolveDescriptor(row.builtin, row.overlay, row.probe).source).toBe(row.source);
      });
    }
  });

  it("an EMPTY overlay object is not a layer — `{}` must not turn `builtin` into `merged`", () => {
    // The whole point: `AgentDescriptor.runtime` is `.prefault({})`, so EVERY configured agent
    // arrives with an overlay object whether or not the operator wrote one.
    expect(resolveDescriptor(CLAUDE, overlay({}), null).source).toBe("builtin");
  });

  it("config REPLACES a capability's spellings rather than merging two orders", () => {
    const d = resolveDescriptor(
      CLAUDE,
      overlay({ prefer: { setConfig: { spellings: ["vendor/set"] } } }),
      null,
    );
    expect(d.prefer["setConfig"]).toEqual({ spellings: ["vendor/set"], onFailure: "fail" });
    // A capability the overlay did not name is untouched.
    expect(d.prefer["resume"]).toEqual(CLAUDE.prefer["resume"]);
  });

  it("`onFailure` defaults to `fail` for an operator-declared capability (review R2)", () => {
    const d = resolveDescriptor(null, overlay({ prefer: { x: { spellings: ["a/b"] } } }), null);
    expect(d.prefer["x"]).toEqual({ spellings: ["a/b"], onFailure: "fail" });
  });

  it("config quirks are a PARTIAL: unnamed quirks keep the builtin's value", () => {
    const d = resolveDescriptor(CLAUDE, overlay({ quirks: { diffIsFragment: false } }), null);
    expect(d.quirks.diffIsFragment).toBe(false);
    expect(d.quirks.messageIdPresent).toBe(true);
    expect(d.quirks.configIdField).toBe("configId");
  });

  it("an UNKNOWN quirk key is a startup failure, never a silently dropped knob", () => {
    expect(() =>
      resolveDescriptor(CLAUDE, overlay({ quirks: { diffIsFragmnt: true } }), null),
    ).toThrow(/not a known quirk/);
  });

  it("a quirk of the wrong TYPE is a startup failure that names the field", () => {
    expect(() =>
      resolveDescriptor(CLAUDE, overlay({ quirks: { messageIdPresent: "yes" } }), null),
    ).toThrow(/messageIdPresent must be a boolean/);
    expect(() =>
      resolveDescriptor(CLAUDE, overlay({ quirks: { configIdField: "nope" } }), null),
    ).toThrow(/configIdField must be one of configId \| optionId/);
  });

  it("operator errorRules are PREPENDED, so they win without deleting the builtin's rows", () => {
    const d = resolveDescriptor(
      CLAUDE,
      overlay({ errorRules: [{ id: "mine", code: -32000, classify: "agent_error" }] }),
      null,
    );
    expect(d.errorRules.map((r) => r.id)).toEqual(["mine", "bad-config-value", "unknown-method"]);
  });

  it("an operator rule that reuses a builtin id SHADOWS it exactly once", () => {
    const d = resolveDescriptor(
      CLAUDE,
      overlay({ errorRules: [{ id: "unknown-method", code: -1, classify: "bad_request" }] }),
      null,
    );
    expect(d.errorRules.map((r) => r.id)).toEqual(["unknown-method", "bad-config-value"]);
    expect(d.errorRules[0]).toEqual({ id: "unknown-method", code: -1, classify: "bad_request" });
  });

  it("updates and extensions merge per key; inboundAliases merge per method", () => {
    const d = resolveDescriptor(
      CLAUDE,
      overlay({
        updates: { plan: { map: "plan", stream: true, store: true } },
        extensions: { quota: { pointer: "/vendor~1quota", as: "opaque" } },
        inboundAliases: { "session/notification": "session/update" },
      }),
      null,
    );
    expect(Object.keys(d.updates).sort()).toEqual(["available_commands_update", "plan"]);
    expect(d.updates["plan"]).toEqual({ map: "plan", stream: true, store: true, digest: false });
    expect(Object.keys(d.extensions).sort()).toEqual(["patch", "quota", "rateLimit"]);
    expect(d.inboundAliases).toEqual({ "session/notification": "session/update" });
  });

  it("budgets are a partial: an unnamed budget keeps the builtin's number, never `undefined`", () => {
    const d = resolveDescriptor(CLAUDE, overlay({ budgets: { turnMs: 1_000 } }), null);
    expect(d.budgets).toEqual({ ...CLAUDE.budgets, turnMs: 1_000 });
  });

  it("`unverified` written by an operator REPLACES the corpus claim rather than adding to it", () => {
    const d = resolveDescriptor(CLAUDE, overlay({ unverified: ["plan"] }), null);
    expect(d.unverified).toEqual(["plan"]);
  });

  it("REJECTS the forbidden {stream:false, store:true} shape, on the MERGED result (§14.6)", () => {
    expect(() =>
      resolveDescriptor(
        CLAUDE,
        overlay({ updates: { usage_update: { map: null, stream: false, store: true } } }),
        null,
      ),
    ).toThrow(/forbidden/);
  });

  it("the rejection is a bad_request an operator can read, naming the kind", () => {
    try {
      resolveDescriptor(
        null,
        overlay({ updates: { plan: { map: null, stream: false, store: true } } }),
        null,
      );
      expect.unreachable();
    } catch (e) {
      expect(OmniError.is(e, "bad_request")).toBe(true);
      expect((e as OmniError).message).toContain("updates.plan");
    }
  });

  it("allows the two LEGAL shapes: stream+store, and drop (neither)", () => {
    const kept = resolveDescriptor(
      null,
      overlay({ updates: { plan: { map: null, stream: true, store: true } } }),
      null,
    );
    const dropped = resolveDescriptor(
      null,
      overlay({ updates: { plan: { map: null, stream: false, store: false } } }),
      null,
    );
    expect(kept.updates["plan"]?.store).toBe(true);
    expect(dropped.updates["plan"]).toEqual({
      map: null,
      stream: false,
      store: false,
      digest: false,
    });
  });
});

describe("resolveDescriptor — the probe layer (§17.2, applied last)", () => {
  it("takes the fingerprint from the probe: a descriptor change is VISIBLE, not silent", () => {
    const d = resolveDescriptor(CLAUDE, EMPTY, probe({ descriptorFingerprint: "abc123" }));
    expect(d.fingerprint).toBe("abc123");
    expect(CLAUDE.fingerprint).toBe("unresolved");
  });

  it("learns `configId` from the probe's learnedParams (F17), overriding the quirk table", () => {
    const d = resolveDescriptor(
      { ...CLAUDE, quirks: { ...CLAUDE.quirks, configIdField: "optionId" } },
      EMPTY,
      probe({ learnedParams: { "session/set_config_option": "configId" } }),
    );
    expect(d.quirks.configIdField).toBe("configId");
  });

  it("ignores a learnedParams value that is not one of the two the type allows", () => {
    const d = resolveDescriptor(
      CLAUDE,
      EMPTY,
      probe({ learnedParams: { "session/set_config_option": "somethingElse" } }),
    );
    expect(d.quirks.configIdField).toBe("configId");
  });

  it("REORDERS spellings by what the probe proved — and DISCARDS nothing (§17.3)", () => {
    const three: RuntimeDescriptor = {
      ...CLAUDE,
      prefer: {
        ...CLAUDE.prefer,
        setConfig: {
          spellings: ["session/set_model", "session/set_mode", "session/set_config_option"],
          onFailure: "fail",
        },
      },
    };
    const d = resolveDescriptor(
      three,
      EMPTY,
      probe({
        supportedMethods: ["session/set_config_option", "session/set_mode"],
        unsupportedMethods: ["session/set_model"],
      }),
    );
    // Proven first (in declared order among themselves), proven-absent last, and STILL PRESENT:
    // a version bump may add `set_model` back, and `noteUnsupported` is per process (§17.3).
    expect(d.prefer["setConfig"]?.spellings).toEqual([
      "session/set_mode",
      "session/set_config_option",
      "session/set_model",
    ]);
  });

  it("a spelling the probe never mentioned keeps its declared rank, between proven and absent", () => {
    const d = resolveDescriptor(
      {
        ...CLAUDE,
        prefer: { c: { spellings: ["a", "b", "c"], onFailure: "fail" } },
      },
      EMPTY,
      probe({ supportedMethods: ["c"], unsupportedMethods: ["a"] }),
    );
    expect(d.prefer["c"]?.spellings).toEqual(["c", "b", "a"]);
  });

  it("a probe that proved nothing leaves the order exactly as declared", () => {
    const d = resolveDescriptor(CLAUDE, EMPTY, probe());
    expect(d.prefer).toEqual(CLAUDE.prefer);
  });

  it("takes protocolVersion from the probe, and refuses a version the type cannot hold", () => {
    expect(resolveDescriptor(CLAUDE, EMPTY, probe({ protocolVersion: 2 })).protocolVersion).toBe(2);
    expect(resolveDescriptor(CLAUDE, EMPTY, probe({ protocolVersion: 7 })).protocolVersion).toBe(1);
  });

  it("the probe never deletes what an operator wrote — only its order can change", () => {
    const d = resolveDescriptor(
      CLAUDE,
      overlay({ prefer: { setConfig: { spellings: ["vendor/a", "vendor/b"] } } }),
      probe({ unsupportedMethods: ["vendor/a"] }),
    );
    expect([...(d.prefer["setConfig"]?.spellings ?? [])].sort()).toEqual(["vendor/a", "vendor/b"]);
    expect(d.prefer["setConfig"]?.spellings[0]).toBe("vendor/b");
  });
});

describe("resolveDescriptor — purity", () => {
  it("is a function of its three arguments: same inputs, deep-equal output, twice", () => {
    const p = probe({ supportedMethods: ["session/list"] });
    const o = overlay({ quirks: { loadReturnsBody: false }, budgets: { turnMs: 5 } });
    expect(resolveDescriptor(CLAUDE, o, p)).toEqual(resolveDescriptor(CLAUDE, o, p));
  });

  it("does not mutate the builtin it was handed", () => {
    const before = structuredClone(CLAUDE);
    resolveDescriptor(
      CLAUDE,
      overlay({ prefer: { resume: { spellings: ["x"] } }, quirks: { diffIsFragment: false } }),
      probe({ unsupportedMethods: ["session/load"] }),
    );
    expect(CLAUDE).toEqual(before);
  });
});

describe("assertDescriptorLegal", () => {
  it("passes every builtin this repository ships", () => {
    expect(() => {
      assertDescriptorLegal(DEFAULT_V1_PROFILE);
      for (const b of BUILTIN_RUNTIMES) assertDescriptorLegal(b.descriptor);
    }).not.toThrow();
  });

  it("rejects a digest that is never stored", () => {
    expect(() =>
      assertDescriptorLegal({
        ...DEFAULT_V1_PROFILE,
        updates: { plan: { map: null, stream: true, store: false, digest: true } },
      }),
    ).toThrow(/digests a payload that is never stored/);
  });
});
