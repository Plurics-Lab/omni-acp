import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  DaemonConfig,
  OmniError,
  PolicyPreset,
  PolicySelection,
  type AuthContext,
  type ClientId,
  type PolicyCeiling,
  type PolicySubject,
  type ResolvedDaemonConfig,
  type TokenId,
} from "@omni-acp/protocol";
import { resolvePolicyForRequest, availablePresets } from "../../src/policy/resolve.js";
import { ceilingFor } from "../../src/policy/ceiling.js";

/**
 * `resolvePolicyForRequest` — the ONE place `403 policy_exceeds_ceiling` is raised, and it is
 * raised at CREATE so the operator sees it where they can act on it.
 *
 * The `AuthContext` here is a literal rather than a real one from `createTokenStore`: this file
 * is about the policy resolution, and `auth.ts` is M2-WP-J's join. What this file DOES take from
 * the real thing is the shape — `tokenId`, `policyCeiling` — so the wiring WP-J writes is a
 * one-liner rather than an adaptation.
 *
 * Owned by M2-B-WP-P.
 */

const SECRET = "user-secret-value-0123456789";

function config(over?: Record<string, unknown>): ResolvedDaemonConfig {
  return DaemonConfig.parse({
    dataDir: tmpdir(),
    tokens: [
      { id: "wide", secret: SECRET, role: "user", cwdRoots: [tmpdir()] },
      {
        id: "narrow",
        secret: SECRET,
        role: "user",
        cwdRoots: [tmpdir()],
        policyPresets: ["readonly"],
        // Wide enough for the shipped `readonly` and nothing else: the four read-ish kinds it
        // grants, and no scoping that its own unscoped allow rule would trip over. A ceiling that
        // refused its token's ONE permitted preset would make every case below vacuous.
        policyCeiling: { allowKinds: ["read", "search", "think", "fetch"] },
      },
      {
        id: "scoped",
        secret: SECRET,
        role: "user",
        cwdRoots: [tmpdir()],
        policyCeiling: { pathRoots: ["src"], park: false },
      },
    ],
    ...(over ?? {}),
  } as Parameters<typeof DaemonConfig.parse>[0]);
}

function auth(tokenId: string, cfg: ResolvedDaemonConfig): AuthContext {
  const token = cfg.tokens.find((t) => t.id === tokenId);
  return {
    tokenId: tokenId as TokenId,
    role: "user",
    clientId: "cli_1" as ClientId,
    leaseEpoch: null,
    agents: "*",
    cwdRoots: [tmpdir()],
    maxWorkers: 16,
    policyCeiling: (token?.policyCeiling ?? null) as PolicyCeiling | null,
    assertAgent() {
      /* not this file's business */
    },
    assertCwd: (cwd: string) => Promise.resolve(cwd),
    canSee: () => true,
    assertPolicy(sel) {
      return resolvePolicyForRequest(cfg, this, sel);
    },
    assertEnv: () => ({ env: {}, keys: [], persist: true }),
    assertMcp: () => [],
    asClientRef: () => ({ tokenId: tokenId as TokenId, clientId: "cli_1" as ClientId }),
  };
}

const select = (sel: unknown): PolicySelection => PolicySelection.parse(sel) as PolicySelection;

const subject = (over: Partial<PolicySubject> = {}): PolicySubject => ({
  method: "session/request_permission",
  type: "tool_call",
  kind: "read",
  paths: [],
  command: null,
  title: "t",
  agentId: "fixture",
  cwd: "/repo",
  ...over,
});

const refusal = (run: () => unknown): OmniError => {
  try {
    run();
  } catch (e) {
    return e as OmniError;
  }
  throw new Error("resolvePolicyForRequest accepted a request it should have refused");
};

describe("resolvePolicyForRequest (§20.5)", () => {
  it("a preset name, a list of names and an inline document all resolve, inline last-wins", () => {
    const cfg = config();
    const a = auth("wide", cfg);

    expect(resolvePolicyForRequest(cfg, a, select("readonly")).snapshot.sources).toEqual([
      "readonly",
    ]);
    expect(resolvePolicyForRequest(cfg, a, select(["readonly", "full"])).snapshot.sources).toEqual([
      "readonly",
      "full",
    ]);

    const merged = resolvePolicyForRequest(
      cfg,
      a,
      select({
        presets: ["readonly"],
        rules: [{ id: "x", match: { kind: ["read"] }, action: "deny" }],
      }),
    );
    expect(merged.snapshot.sources).toEqual(["readonly", "inline"]);
    // Inline is consulted first, so it NARROWS the preset's grant rather than sitting behind it.
    expect(merged.decide(subject({ kind: "read" })).action).toBe("deny");
    expect(merged.decide(subject({ kind: "read" })).source).toBe("inline");
  });

  it("an absent selection resolves to the daemon's configured default preset", () => {
    const cfg = config({ policy: { default: "readonly", presets: {} } });
    const engine = resolvePolicyForRequest(cfg, auth("wide", cfg), undefined);
    expect(engine.snapshot.sources).toEqual(["readonly"]);
    expect(engine.decide(subject({ kind: "read" })).action).toBe("allow");
    expect(engine.decide(subject({ kind: "edit" })).action).toBe("deny");
  });

  it("the five shipped presets are available without an operator writing a line of config", () => {
    const cfg = config();
    expect(Object.keys(availablePresets(cfg)).sort()).toEqual([
      "deny-all",
      "full",
      "readonly",
      "readonly-contained",
      "src-edit",
    ]);
  });

  it("an operator may REPLACE a shipped preset by name, which is what 'data, not code' means", () => {
    const cfg = config({
      policy: {
        default: "deny-all",
        presets: {
          readonly: PolicyPreset.parse({
            default: "deny",
            rules: [{ id: "mine", match: { kind: ["read"] }, action: "park" }],
          }),
        },
      },
    });
    const engine = resolvePolicyForRequest(cfg, auth("wide", cfg), select("readonly"));
    expect(engine.decide(subject({ kind: "read" })).action).toBe("park");
  });

  it("an unknown preset name is a 400 NAMING it — including one reached through extends", () => {
    const cfg = config();
    const e = refusal(() => resolvePolicyForRequest(cfg, auth("wide", cfg), select("nope")));
    expect(e.code).toBe("bad_request");
    expect(e.status).toBe(400);
    expect(e.message).toContain('"nope"');

    const dangling = config({
      policy: {
        default: "deny-all",
        presets: { broken: PolicyPreset.parse({ extends: "missing", default: "deny" }) },
      },
    });
    expect(
      refusal(() => resolvePolicyForRequest(dangling, auth("wide", dangling), select("broken")))
        .message,
    ).toContain('"missing"');
  });

  it("a name outside the token's policyPresets is a 403, and the ACL is checked FIRST", () => {
    const cfg = config();
    const narrow = auth("narrow", cfg);

    expect(refusal(() => resolvePolicyForRequest(cfg, narrow, select("full"))).code).toBe(
      "forbidden",
    );
    // ...and a name that does not exist EITHER is still the 403, so the route cannot be used to
    // enumerate which presets an operator has configured.
    const e = refusal(() => resolvePolicyForRequest(cfg, narrow, select("does-not-exist")));
    expect(e.code).toBe("forbidden");
    expect(e.status).toBe(403);

    // The token's own preset resolves.
    expect(resolvePolicyForRequest(cfg, narrow, select("readonly")).snapshot.sources).toEqual([
      "readonly",
    ]);
  });

  it("the default '*' allowlist lets an unknown name reach its 400", () => {
    const cfg = config();
    expect(
      refusal(() => resolvePolicyForRequest(cfg, auth("wide", cfg), select("nope"))).code,
    ).toBe("bad_request");
  });

  it("a merge exceeding the token's ceiling is 403 with body.policy.{ceiling, offending}", () => {
    const cfg = config();
    const e = refusal(() =>
      resolvePolicyForRequest(
        cfg,
        auth("narrow", cfg),
        select({
          presets: ["readonly"],
          rules: [{ id: "x", match: { kind: ["edit"] }, action: "allow" }],
        }),
      ),
    );
    expect(e.code).toBe("policy_exceeds_ceiling");
    expect(e.status).toBe(403);
    const body = e.toBody().policy;
    expect(body?.ceiling).toBe("token:narrow");
    expect(body?.offending).toEqual(['readonly+inline#inline:x: kind "edit" is not in allowKinds']);
  });

  it("the 403 fires at CREATE — no engine is ever handed back that exceeds the ceiling", () => {
    const cfg = config();
    // The point of raising here rather than at the first permission request: the caller never
    // holds a wider engine, so there is no window in which the wider document is in force.
    expect(() =>
      resolvePolicyForRequest(cfg, auth("narrow", cfg), select({ presets: ["full"] })),
    ).toThrow();
  });

  it("park:false refuses the create request's onUnresolved as well as the document (review R6)", () => {
    const cfg = config();
    const scoped = auth("scoped", cfg);
    const e = refusal(() =>
      resolvePolicyForRequest(cfg, scoped, select("deny-all"), { onUnresolved: "park" }),
    );
    expect(e.policy?.offending).toEqual(['request#onUnresolved: "park" is refused by park:false']);

    // ...and the shipped `src-edit`, whose DEFAULT is park, is refused for the same token even
    // when the request asked for `deny` — which is the hole review R6 records.
    expect(
      refusal(() =>
        resolvePolicyForRequest(cfg, scoped, select("src-edit"), { onUnresolved: "deny" }),
      ).policy?.offending,
    ).toContain('readonly+src-edit#default: a default of "park" is refused by park:false');

    expect(() =>
      resolvePolicyForRequest(cfg, scoped, select("deny-all"), { onUnresolved: "deny" }),
    ).not.toThrow();
  });

  it("a token with NO ceiling gets no clamp, and the snapshot says so", () => {
    const cfg = config();
    const engine = resolvePolicyForRequest(cfg, auth("wide", cfg), select("full"));
    expect(engine.snapshot.ceiling).toBeNull();
    expect(engine.decide(subject({ kind: "read", paths: ["/etc/passwd"] })).clamped).toBeNull();
  });

  it("a ceilinged token still CLAMPS at decision time, and the clamp names the token's ceiling", () => {
    const cfg = config();
    const engine = resolvePolicyForRequest(
      cfg,
      auth("scoped", cfg),
      select({
        rules: [{ id: "wide", match: { kind: ["edit"], path: ["src*/**"] }, action: "allow" }],
      }),
    );
    const escaping = engine.decide(
      subject({ kind: "edit", paths: ["/repo/src-secrets/keys.txt"] }),
    );
    expect(escaping.action).not.toBe("allow");
    expect(escaping.clamped?.by).toBe("token:scoped:pathRoots");
    expect(engine.snapshot.ceiling).toBe("token:scoped");
  });

  it("AuthContext.assertPolicy delegates here, which is the wiring WP-J inherits", () => {
    const cfg = config();
    const a = auth("narrow", cfg);
    expect(a.assertPolicy(select("readonly")).snapshot.sources).toEqual(["readonly"]);
    expect(refusal(() => a.assertPolicy(select("full"))).code).toBe("forbidden");
  });
});

describe("ceilingFor — the ceiling as a NAMED thing", () => {
  it("names the token it belongs to, because that is what an operator has to edit", () => {
    const cfg = config();
    expect(ceilingFor(cfg, "narrow")?.name).toBe("token:narrow");
    expect(ceilingFor(cfg, "narrow")?.ceiling.allowKinds).toEqual([
      "read",
      "search",
      "think",
      "fetch",
    ]);
    expect(ceilingFor(cfg, "scoped")?.ceiling.park).toBe(false);
  });

  it("is null for a token with no ceiling, and for a token that is not in the config", () => {
    const cfg = config();
    expect(ceilingFor(cfg, "wide")).toBeNull();
    expect(ceilingFor(cfg, "nobody")).toBeNull();
  });
});
