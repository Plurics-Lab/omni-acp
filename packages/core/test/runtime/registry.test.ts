import { describe, expect, it } from "vitest";
import type { RuntimeDescriptor } from "@omni-acp/protocol";
import { createVendorRegistry } from "../../src/normalizer/vendor/registry.js";
import { BUILTIN_RUNTIMES, DEFAULT_V1_PROFILE } from "../../src/runtime/known.js";

const CLAUDE = BUILTIN_RUNTIMES[0]!.descriptor;

/**
 * WP-E acceptance 4, second half: the vendor registry expresses PREFERENCE ORDER
 * (`set_config_option` → `set_mode` → `set_model`) and learns `-32601` PER PROCESS.
 *
 * The three-spelling descriptor is a TEST descriptor rather than the claude-acp builtin: §17.2's
 * table lists exactly two spellings for `setConfig`, because the corpus PROVED `set_model`
 * absent on 0.73.0 and every field of that table is an observation. Walking three spellings is a
 * property of the registry, so the registry's own suite is where it is proven.
 */
const THREE: RuntimeDescriptor = {
  ...CLAUDE,
  prefer: {
    ...CLAUDE.prefer,
    setConfig: {
      spellings: ["session/set_config_option", "session/set_mode", "session/set_model"],
      onFailure: "fail",
    },
  },
};

describe("VendorRegistry — preference order over spellings (§17.3)", () => {
  it("hands back the descriptor's order, untouched, before anything is learned", () => {
    const registry = createVendorRegistry(THREE);
    expect(registry.spellingsFor("setConfig")).toEqual([
      "session/set_config_option",
      "session/set_mode",
      "session/set_model",
    ]);
  });

  it("walks the order as spellings are disproved, one -32601 at a time", () => {
    const registry = createVendorRegistry(THREE);
    expect(registry.spellingsFor("setConfig")[0]).toBe("session/set_config_option");

    registry.noteUnsupported("session/set_config_option");
    expect(registry.spellingsFor("setConfig")[0]).toBe("session/set_mode");

    registry.noteUnsupported("session/set_mode");
    expect(registry.spellingsFor("setConfig")[0]).toBe("session/set_model");

    registry.noteUnsupported("session/set_model");
    // Every spelling exhausted: the CALLER reports `unsupported` (the empty list is the signal).
    expect(registry.spellingsFor("setConfig")).toEqual([]);
  });

  it("expresses F18: two spellings live on ONE process while a third is -32601", () => {
    // The fact a one-name-per-capability registry could not represent.
    const registry = createVendorRegistry(THREE);
    registry.noteUnsupported("session/set_model");
    expect(registry.spellingsFor("setConfig")).toEqual([
      "session/set_config_option",
      "session/set_mode",
    ]);
  });

  it("learning is PER PROCESS: a second registry over the same descriptor knows nothing", () => {
    const first = createVendorRegistry(THREE);
    first.noteUnsupported("session/set_config_option");
    expect(first.spellingsFor("setConfig")).not.toContain("session/set_config_option");

    // §17.3: never persisted, because a version bump may add the method back.
    const second = createVendorRegistry(THREE);
    expect(second.spellingsFor("setConfig")[0]).toBe("session/set_config_option");
  });

  it("the probe's unsupportedMethods SEED the set at construction (§17.3)", () => {
    const registry = createVendorRegistry(THREE, {
      seedUnsupported: ["session/set_config_option", "session/set_model"],
    });
    expect(registry.spellingsFor("setConfig")).toEqual(["session/set_mode"]);
    expect([...registry.unsupported].sort()).toEqual([
      "session/set_config_option",
      "session/set_model",
    ]);
  });

  it("noteUnsupported is idempotent and affects EVERY capability that spells it that way", () => {
    const shared: RuntimeDescriptor = {
      ...DEFAULT_V1_PROFILE,
      prefer: {
        a: { spellings: ["x/y", "x/z"], onFailure: "fail" },
        b: { spellings: ["x/y"], onFailure: "warn" },
      },
    };
    const registry = createVendorRegistry(shared);
    registry.noteUnsupported("x/y");
    registry.noteUnsupported("x/y");
    expect(registry.spellingsFor("a")).toEqual(["x/z"]);
    expect(registry.spellingsFor("b")).toEqual([]);
    expect(registry.unsupported.size).toBe(1);
  });

  it("never mutates the descriptor's own arrays", () => {
    const registry = createVendorRegistry(THREE);
    const before = [...(THREE.prefer["setConfig"]?.spellings ?? [])];
    registry.noteUnsupported("session/set_mode");
    void registry.spellingsFor("setConfig");
    expect(THREE.prefer["setConfig"]?.spellings).toEqual(before);
  });
});

describe("VendorRegistry — onFailure is per capability (DESIGN §6.2, review R2)", () => {
  it("`setConfig` fails the turn; `setOptions` only warns", () => {
    const registry = createVendorRegistry(CLAUDE);
    expect(registry.onFailureFor("setConfig")).toBe("fail");
    expect(registry.onFailureFor("setOptions")).toBe("warn");
  });

  it("an unknown capability defaults to `fail`, the conservative answer", () => {
    const registry = createVendorRegistry(CLAUDE);
    expect(registry.onFailureFor("somethingNobodyDeclared")).toBe("fail");
  });
});

describe("VendorRegistry — a capability nobody declared (the RECORD, not four arrays)", () => {
  it("returns [] for an unknown capability rather than throwing", () => {
    const registry = createVendorRegistry(CLAUDE);
    expect(registry.spellingsFor("interactions")).toEqual([]);
  });

  it("carries a capability M1 never named, because `prefer` is a record (review R2)", () => {
    const forked: RuntimeDescriptor = {
      ...DEFAULT_V1_PROFILE,
      prefer: {
        ...DEFAULT_V1_PROFILE.prefer,
        fork: { spellings: ["session/fork"], onFailure: "warn" },
      },
    };
    const registry = createVendorRegistry(forked);
    expect(registry.spellingsFor("fork")).toEqual(["session/fork"]);
    expect(registry.onFailureFor("fork")).toBe("warn");
  });

  it("does not read a capability off Object.prototype", () => {
    const registry = createVendorRegistry(CLAUDE);
    expect(registry.spellingsFor("constructor")).toEqual([]);
    expect(registry.spellingsFor("__proto__")).toEqual([]);
  });
});

describe("VendorRegistry — the descriptor is the only thing it branches on (§17.1)", () => {
  it("two registries over two descriptors of the SAME agent id behave differently", () => {
    // A compatible fork is a new descriptor, not a new code path: nothing here reads an agent id.
    const a = createVendorRegistry({
      ...CLAUDE,
      prefer: { close: { spellings: ["a/close"], onFailure: "fail" } },
    });
    const b = createVendorRegistry({
      ...CLAUDE,
      prefer: { close: { spellings: ["b/close"], onFailure: "warn" } },
    });
    expect(a.spellingsFor("close")).toEqual(["a/close"]);
    expect(b.spellingsFor("close")).toEqual(["b/close"]);
    expect(a.descriptor.id).toBe(b.descriptor.id);
  });
});
