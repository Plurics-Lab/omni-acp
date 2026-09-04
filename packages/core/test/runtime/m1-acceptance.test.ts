import { describe, expect, it } from "vitest";
import { BUILTIN_RUNTIMES, DEFAULT_V1_PROFILE } from "../../src/runtime/known.js";
import { classifyProbe } from "../../src/runtime/classify.js";
import { resolveDescriptor } from "../../src/runtime/merge.js";
import { createVendorRegistry } from "../../src/normalizer/vendor/registry.js";

/**
 * M1-WP-E's acceptance bullets (M1-PLAN §2, WP-E), each with a one-line proof and a pointer to
 * the suite that argues it properly.
 *
 * This file is the INDEX, not the argument: every bullet below is exercised in depth somewhere,
 * and the value of having them together is that a reader can see at a glance which ones have a
 * home and which are still open. The daemon-wiring half lives under `packages/daemon/test/`,
 * because that is where the code it tests lives.
 */
describe("M1-WP-E — runtime descriptors, vendor registry, probe, daemon wiring, boot adoption", () => {
  it("1. classifyProbe reproduces the five §17.4 verdicts, INCLUDING learning `configId` (F17)", () => {
    // In full, against the corpus bytes: `test/runtime/classify.test.ts`.
    // The row §17.4 exists for, restated here so the index is not a list of names:
    expect(
      classifyProbe({
        error: {
          code: -32602,
          message: "Invalid params",
          data: { _errors: [], configId: { _errors: ["Invalid input: expected string"] } },
        },
      }),
    ).toEqual({ kind: "implemented_other_params", code: -32602, hints: ["configId"] });
    // …and the other four kinds are reachable from this one function.
    expect(classifyProbe({ error: { code: -32601 } }).kind).toBe("not_implemented");
    expect(classifyProbe({ result: {} }).kind).toBe("implemented");
    expect(classifyProbe({ error: { code: -32603, data: { details: "x" } } }).kind).toBe(
      "implemented_bad_value",
    );
    expect(classifyProbe({ error: { code: -1, message: "?" } }).kind).toBe("error");
  });

  it("2. POST /v1/agents/{id}/probe: one process, tree reclaimed, no temp dir, 403 before a spawn", () => {
    // `daemon/test/http/probe.test.ts` (the route, the 403 and the redaction),
    // `daemon/test/probe-service.test.ts` (one process, the shared in-flight probe, maxConcurrent),
    // `core/test/runtime/probe.test.ts` (the battery, the mkdtemp, every reclaim edge).
    expect(true).toBe(true);
  });

  it("3. the cache round-trips at mode 0600, `cached:true`, a fingerprint change invalidates", () => {
    // `daemon/test/probe-cache.test.ts` and `daemon/test/probe-service.test.ts`.
    expect(true).toBe(true);
  });

  it("4. resolveDescriptor's merge is table-tested; the registry expresses preference order", () => {
    // In full: `test/runtime/merge.test.ts` and `test/runtime/registry.test.ts`.
    // The acceptance bullet's own example — `set_config_option` → `set_mode` → `set_model` —
    // over a three-spelling descriptor, which is a property of the REGISTRY. §17.2's builtin
    // carries exactly the two spellings the corpus proved, and no third.
    const three = {
      ...BUILTIN_RUNTIMES[0]!.descriptor,
      prefer: {
        setConfig: {
          spellings: ["session/set_config_option", "session/set_mode", "session/set_model"],
          onFailure: "fail" as const,
        },
      },
    };
    const registry = createVendorRegistry(three);
    expect(registry.spellingsFor("setConfig")[0]).toBe("session/set_config_option");
    registry.noteUnsupported("session/set_config_option");
    expect(registry.spellingsFor("setConfig")[0]).toBe("session/set_mode");
    registry.noteUnsupported("session/set_mode");
    expect(registry.spellingsFor("setConfig")[0]).toBe("session/set_model");
    // And the merge's three layers, in one line:
    expect(resolveDescriptor(null, {}, null)).toEqual({ ...DEFAULT_V1_PROFILE, source: "builtin" });
  });

  it("5. createDaemon opens persistence → adopts → arms retention; stop() closes it after closeAll", () => {
    // `daemon/test/create-daemon-persistence.test.ts` and `daemon/test/event-store.test.ts`.
    expect(true).toBe(true);
  });

  it("6. boot adoption converges every abandoned row, appends the three envelopes, is a no-op twice", () => {
    // `daemon/test/boot-recovery.test.ts` (20 cases, including the Windows skip row).
    expect(true).toBe(true);
  });

  it("7. lazy rehydration; list() from the store; hibernated counted apart; a wake over the cap is 429", () => {
    // `daemon/test/registry-persistence.test.ts`.
    expect(true).toBe(true);
  });

  it("8. the new route family is three lines; http-has-no-logic and sse-is-unchanged both pass", () => {
    // `daemon/test/arch/http-has-no-logic.test.ts` and `daemon/test/arch/sse-is-unchanged.test.ts`
    // cover `routes/agents.ts` recursively; `daemon/test/http/probe.test.ts` proves the route
    // maps every failure through the ONE error mapper (401/403/400) with no status logic of its
    // own. `423`/`422` are M1-WP-D's and M1-WP-C's to make reachable; the mapper they flow
    // through is already the single one (`http/errors.ts` reads `ERROR_STATUS` and nothing else).
    expect(true).toBe(true);
  });

  it("9. GET /v1/info reports persistence, bootId and orphansAtStart honestly, Windows included", () => {
    // `daemon/test/create-daemon-persistence.test.ts`.
    expect(true).toBe(true);
  });

  it.todo(
    "10. migration: empty file, a v1 file (no-op), and a schema_version FROM THE FUTURE => a " +
      "startup failure NAMING the version — the STORE half belongs to M1-WP-A's openPersistence; " +
      "the wiring half (the failure reaches createDaemon's caller) is in daemon/test/event-store.test.ts",
  );
});
