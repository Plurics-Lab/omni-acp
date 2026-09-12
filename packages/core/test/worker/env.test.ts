import { describe, expect, it } from "vitest";
import { resolveWorkerEnv } from "@omni-acp/core";
import { ENV_DENY_EXACT, ENV_DENY_PREFIX, OmniError } from "@omni-acp/protocol";
import { packageSources, sourceFile } from "../mcp/scan.js";

/**
 * `resolveWorkerEnv` — DESIGN §8's ONE deny table, and the Windows case-folding trap.
 *
 * WP-S acceptance 4, 5 and the `envKeys` half of 6.
 *
 * Owned by M2-B-WP-S.
 */

const BASE = { PATH: "/usr/bin", HOME: "/home/agent", LANG: "C" } as const;
const DESCRIPTOR = { ANTHROPIC_API_KEY: "sk-operator", AGENT_PROFILE: "default" } as const;

interface Overrides {
  request?: Record<string, string> | undefined;
  extraDeny?: readonly string[];
  allow?: readonly string[];
  platform?: NodeJS.Platform;
  descriptor?: Record<string, string>;
  persist?: boolean;
}

function resolve(o: Overrides = {}) {
  return resolveWorkerEnv({
    base: BASE,
    descriptor: o.descriptor ?? DESCRIPTOR,
    request: o.request,
    extraDeny: o.extraDeny ?? [],
    // Wide open by default, so a test that is ABOUT the deny list is not accidentally testing
    // the ACL instead.
    allow: o.allow ?? ["ANYTHING"],
    platform: o.platform ?? "linux",
    ...(o.persist === undefined ? {} : { persist: o.persist }),
  });
}

function thrown(o: Overrides): OmniError {
  try {
    resolve(o);
  } catch (e) {
    if (e instanceof OmniError) return e;
    throw new Error(`expected an OmniError, got ${String(e)}`, { cause: e });
  }
  throw new Error("expected a throw, got a return");
}

describe("resolveWorkerEnv (§23.3) — the empty request, which is every M1 request", () => {
  it("resolves an absent map to the descriptor's environment and NO keys", () => {
    expect(resolve({ request: undefined })).toStrictEqual({
      env: { ...BASE, ...DESCRIPTOR },
      keys: [],
      persist: true,
    });
    expect(resolve({ request: {} }).keys).toEqual([]);
  });

  it("lets the descriptor override the daemon's own environment (D19, unchanged from M1)", () => {
    expect(resolve({ descriptor: { LANG: "en_US.UTF-8" }, request: undefined }).env).toMatchObject({
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin",
    });
  });
});

describe("resolveWorkerEnv — REJECTED, never dropped (M2-R12)", () => {
  it("rejects with a 400 naming the key for EVERY entry of ENV_DENY_EXACT", () => {
    expect(ENV_DENY_EXACT.length).toBeGreaterThan(20);
    for (const key of ENV_DENY_EXACT) {
      const e = thrown({ request: { [key]: "x" }, allow: [key] });
      expect(e.code, key).toBe("bad_request");
      expect(e.status, key).toBe(400);
      // NAMING it. A worker that silently ignored half the environment it was asked for behaves
      // differently from what the caller asked, and nothing says so.
      expect(e.message, key).toContain(`"${key}"`);
      expect(e.detail, key).toStrictEqual({ envKey: key });
    }
  });

  it("rejects with a 400 naming the key for EVERY entry of ENV_DENY_PREFIX", () => {
    expect(ENV_DENY_PREFIX.length).toBeGreaterThan(4);
    for (const prefix of ENV_DENY_PREFIX) {
      const key = `${prefix}SOMETHING`;
      const e = thrown({ request: { [key]: "x" }, allow: [key] });
      expect(e.code, key).toBe("bad_request");
      expect(e.message, key).toContain(`"${key}"`);
      expect(e.message, key).toContain(JSON.stringify(prefix));
    }
  });

  it("names the DESIGN §5.1 five and the arbitrary-code-execution additions explicitly", () => {
    // The floor (DESIGN §5.1) and the reason the list is longer (§23.3): these are execution,
    // not preference. Spelled out rather than derived, so shrinking the table breaks this test.
    for (const key of [
      "HOME",
      "PATH",
      "USER",
      "SHELL",
      "TMPDIR",
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "IFS",
      "RUBYOPT",
      "PERL5OPT",
      "JAVA_TOOL_OPTIONS",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "OMNI_TOKEN",
    ]) {
      expect(thrown({ request: { [key]: "x" }, allow: [key] }).code, key).toBe("bad_request");
    }
  });

  it("lets envDeny EXTEND the list and PROVES it cannot shrink it", () => {
    // Extends:
    expect(thrown({ request: { CI: "1" }, allow: ["CI"], extraDeny: ["CI"] }).message).toContain(
      '"CI"',
    );
    // …and cannot shrink. `extraDeny` is additive by construction — nothing is ever removed from
    // the set — so naming a hard key, or every hard key, changes no verdict.
    expect(thrown({ request: { HOME: "/tmp" }, allow: ["HOME"], extraDeny: [] }).code).toBe(
      "bad_request",
    );
    expect(
      thrown({ request: { HOME: "/tmp" }, allow: ["HOME"], extraDeny: [...ENV_DENY_EXACT] }).code,
    ).toBe("bad_request");
    // A key the operator did not name and the hard list does not cover still resolves.
    expect(resolve({ request: { CI: "1" }, allow: ["CI"], extraDeny: ["OTHER"] }).keys).toEqual([
      "CI",
    ]);
  });

  it("checks DENY before the token's ACL, so the hard list can never be widened by envAllow", () => {
    // `allow: ["HOME"]` is an operator writing the one thing that must never work.
    expect(thrown({ request: { HOME: "/tmp" }, allow: ["HOME"] }).code).toBe("bad_request");
  });
});

describe("resolveWorkerEnv — the token's envAllow", () => {
  it("refuses an un-allowed key with a 403 naming it", () => {
    const e = thrown({ request: { MY_FLAG: "1" }, allow: [] });
    expect(e.code).toBe("forbidden");
    expect(e.status).toBe(403);
    expect(e.message).toContain('"MY_FLAG"');
  });

  it("has NO wildcard: envAllow is exact names, and its default of [] means none", () => {
    expect(thrown({ request: { MY_FLAG: "1" }, allow: ["*"] }).code).toBe("forbidden");
    expect(resolve({ request: { MY_FLAG: "1" }, allow: ["MY_FLAG"] }).keys).toEqual(["MY_FLAG"]);
  });
});

describe("resolveWorkerEnv — BOTH platform branches, injected rather than skipped", () => {
  it('rejects {"path": "…"} on win32 and ACCEPTS it on linux', () => {
    // Windows environment variable names are case-INSENSITIVE: `set path=…` replaces `PATH` for
    // real. Comparing case-sensitively there denies nothing at all on the one platform where the
    // attack is a single keystroke.
    const win = thrown({ request: { path: "C:\\evil" }, allow: ["path"], platform: "win32" });
    expect(win.code).toBe("bad_request");
    expect(win.message).toContain('"path"');

    // On linux `path` and `PATH` are two different variables, and `path` is not the dangerous
    // one. The test asserts the ACCEPTANCE too, so a "fold everywhere" fix would fail here.
    const nix = resolve({ request: { path: "/tmp/x" }, allow: ["path"], platform: "linux" });
    expect(nix.keys).toEqual(["path"]);
    expect(nix.env["path"]).toBe("/tmp/x");
    expect(nix.env["PATH"]).toBe("/usr/bin");
  });

  it("folds the PREFIX table on win32 too", () => {
    expect(
      thrown({ request: { node_options: "x" }, allow: ["node_options"], platform: "win32" }).code,
    ).toBe("bad_request");
    expect(resolve({ request: { node_options: "x" }, allow: ["node_options"] }).keys).toEqual([
      "node_options",
    ]);
  });

  it("folds envDeny and envAllow on win32, so an operator's casing is not a second rule", () => {
    expect(
      thrown({ request: { Ci: "1" }, allow: ["Ci"], extraDeny: ["CI"], platform: "win32" }).code,
    ).toBe("bad_request");
    expect(resolve({ request: { Ci: "1" }, allow: ["CI"], platform: "win32" }).keys).toEqual([
      "Ci",
    ]);
  });

  it("refuses two spellings of ONE variable on win32, and allows them on linux", () => {
    const e = thrown({
      request: { My_Flag: "a", MY_FLAG: "b" },
      allow: ["MY_FLAG"],
      platform: "win32",
    });
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("same variable on win32");
    expect(
      resolve({ request: { My_Flag: "a", MY_FLAG: "b" }, allow: ["My_Flag", "MY_FLAG"] }).keys,
    ).toEqual(["MY_FLAG", "My_Flag"]);
  });
});

describe("resolveWorkerEnv — shape is a boundary, not a suggestion", () => {
  it("refuses a key that is not an environment variable name", () => {
    for (const key of ["1BAD", "has-dash", "has space", "has=eq", "", "é", "a\0b"]) {
      const e = thrown({ request: { [key]: "x" }, allow: [key] });
      expect(e.code, JSON.stringify(key)).toBe("bad_request");
      expect(e.message, JSON.stringify(key)).toContain("valid environment variable name");
    }
  });

  it("refuses a NUL in a value, NAMING the key and never the value", () => {
    const e = thrown({ request: { OK_KEY: "before\0after" }, allow: ["OK_KEY"] });
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain('"OK_KEY"');
    expect(e.message).not.toContain("before");
    expect(JSON.stringify(e.detail)).not.toContain("after");
  });

  it("caps the number of keys and the total size", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 65; i++) many[`K_${String(i)}`] = "v";
    expect(thrown({ request: many, allow: Object.keys(many) }).message).toContain("the limit is");

    const big: Record<string, string> = { A_KEY: "x".repeat(300 * 1024) };
    expect(thrown({ request: big, allow: ["A_KEY"] }).message).toContain("bytes");
  });

  it("clamps an over-long key in the message rather than echoing it whole", () => {
    // Long AND refusable, on both arms that echo a key: the 400 for a malformed name and the
    // 403 for one the token may not set.
    const bad = `1${"b".repeat(400)}`;
    const shape = thrown({ request: { [bad]: "x" }, allow: [bad] });
    expect(shape.code).toBe("bad_request");
    expect(shape.message.length).toBeLessThan(160);
    expect(shape.message).toContain("…");
    // …and `detail` still carries the WHOLE key, because that half is logged, not returned.
    expect(shape.detail).toStrictEqual({ envKey: bad });

    const long = `A${"b".repeat(400)}`;
    const acl = thrown({ request: { [long]: "x" }, allow: [] });
    expect(acl.code).toBe("forbidden");
    expect(acl.message.length).toBeLessThan(160);
    expect(acl.message).toContain("…");
  });
});

describe("resolveWorkerEnv — layering, and what reaches a snapshot", () => {
  it("layers the request ON TOP OF the daemon's environment", () => {
    const out = resolve({ request: { LANG: "en_US.UTF-8" }, allow: ["LANG"] });
    expect(out.env["LANG"]).toBe("en_US.UTF-8");
    expect(out.env["PATH"]).toBe("/usr/bin");
  });

  it("REFUSES to overwrite the descriptor's env — the daemon's injected credentials", () => {
    // DESIGN §5.1: per-worker env 叠加在 daemon 密钥库注入的凭据之后. A client that could
    // overwrite a descriptor-supplied variable could point the agent at its own endpoint with the
    // operator's configuration. Refused rather than ignored, for M2-R12's reason.
    //
    // The key moved from `ANTHROPIC_API_KEY` to `AGENT_PROFILE` in M3-WP1, and the reason is that
    // the RULE THIS TEST IS ABOUT got weaker coverage from the old key rather than stronger:
    // M3-WP1 put all six credential variables on `ENV_DENY_EXACT`, so `ANTHROPIC_API_KEY` is now
    // refused one rung EARLIER (the hard deny list, before the ACL and before the descriptor
    // check) and this assertion would have been testing the deny list instead of the descriptor
    // rule. `AGENT_PROFILE` is the other descriptor-supplied variable in `DESCRIPTOR` and is on no
    // list, so it reaches the check this test exists for. The credential key's own, stronger
    // behaviour is asserted immediately below.
    const e = thrown({
      request: { AGENT_PROFILE: "attacker" },
      allow: ["AGENT_PROFILE"],
    });
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("supplied by the agent descriptor");
    expect(e.message).not.toContain("attacker");
    expect(resolve({ request: undefined }).env["AGENT_PROFILE"]).toBe("default");
  });

  it("refuses every M3-WP1 credential variable on the HARD list, ahead of the ACL (DESIGN §8)", () => {
    // The six that M3-WP1 added. Each is the same CLASS as `HOME`: `ANTHROPIC_API_KEY` and its
    // three siblings are credentials the daemon's key store holds, and `CLAUDE_CONFIG_DIR` /
    // `CODEX_HOME` are the whole home-isolation boundary in one variable — a client that could
    // set one would be pointing the agent at a home the daemon did not build.
    //
    // `allow` names the key AND `extraDeny` is empty, which is the strongest form of the
    // assertion: the hard list wins over the token's own ACL, so nothing shrinks it.
    for (const key of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CODEX_API_KEY",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
    ]) {
      expect(ENV_DENY_EXACT).toContain(key);
      const e = thrown({ request: { [key]: "sk-attacker" }, allow: [key] });
      expect(e.code).toBe("bad_request");
      expect(e.message).toContain("deny list");
      expect(e.message).not.toContain("sk-attacker");
    }
    // And the operator's own descriptor value still reaches the agent, which is the half that
    // makes the refusal a boundary rather than a blanket ban.
    expect(resolve({ request: undefined }).env["ANTHROPIC_API_KEY"]).toBe("sk-operator");
  });

  it("carries KEY NAMES ONLY, sorted, and no VALUE anywhere in the resolution's key list", () => {
    const out = resolve({
      request: { ZED: "secret-z", ALPHA: "secret-a" },
      allow: ["ZED", "ALPHA"],
    });
    expect(out.keys).toEqual(["ALPHA", "ZED"]);
    expect(JSON.stringify(out.keys)).not.toContain("secret");
    // The values exist — they have to, something has to spawn the process — but only in `env`.
    expect(out.env["ZED"]).toBe("secret-z");
  });

  it("reports persist:true by default and false when the caller opts out (§23.3)", () => {
    expect(resolve({ request: { CI: "1" }, allow: ["CI"] }).persist).toBe(true);
    expect(resolve({ request: { CI: "1" }, allow: ["CI"], persist: false }).persist).toBe(false);
    // …including for a request that asked for no env at all, so the field is never undefined.
    expect(resolve({ request: undefined, persist: false }).persist).toBe(false);
  });
});

/**
 * Architecture guard: `env-deny-is-one-table` (CONTRACTS.md §23.3, §27.4).
 *
 * "Exactly one module declares `ENV_DENY_EXACT` / `ENV_DENY_PREFIX`." A second copy is how one of
 * two callers quietly stops enforcing it — the same argument `redactArgs` and `hashSecret` are
 * given in §5.1 — and the failure mode is invisible: both copies look right, and only one of them
 * is the one that ran.
 *
 * The guard scans for a DECLARATION, not for a mention: `resolveWorkerEnv` must import and name
 * both tables, and a guard that fired on the name would be a guard against using them.
 */
describe("guard: env-deny-is-one-table (§23.3)", () => {
  const sources = packageSources();
  const DECLARATION =
    /(?:const|let|var|enum|interface|type|function|class)\s+ENV_DENY_(?:EXACT|PREFIX)\b/;

  it("scans a real corpus", () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.map((s) => s.path)).toContain("packages/protocol/src/config.ts");
  });

  it("has exactly ONE declaring module, and it is `protocol/src/config.ts`", () => {
    const declarers = sources.filter((s) => DECLARATION.test(s.code)).map((s) => s.path);
    expect(declarers).toEqual(["packages/protocol/src/config.ts"]);
  });

  it("finds no second table under another name either", () => {
    // A copy renamed to dodge the guard is still a copy. These are what a second table would be
    // called, and none of them may be DECLARED anywhere.
    const aliases = /(?:const|let|var)\s+(?:DENIED_ENV|ENV_BLACKLIST|BLOCKED_ENV|ENV_DENY)\b/;
    expect(sources.filter((s) => aliases.test(s.code)).map((s) => s.path)).toEqual([]);
  });

  it("is demonstrated FAILING on a planted second declaration", () => {
    const planted = [
      ...sources,
      sourceFile(
        "packages/daemon/src/env.ts",
        'export const ENV_DENY_EXACT: readonly string[] = ["HOME"];\n',
      ),
    ];
    expect(planted.filter((s) => DECLARATION.test(s.code)).map((s) => s.path)).toEqual([
      "packages/protocol/src/config.ts",
      "packages/daemon/src/env.ts",
    ]);
  });

  it("does not fire on PROSE, and `env.ts` NAMES both tables without declaring either", () => {
    const prose = sourceFile(
      "packages/core/src/worker/env.ts",
      "// ENV_DENY_EXACT and ENV_DENY_PREFIX live in one module\n" +
        'import { ENV_DENY_EXACT, ENV_DENY_PREFIX } from "@omni-acp/protocol";\n' +
        "const HARD_EXACT: readonly string[] = ENV_DENY_EXACT;\n" +
        "export const x = [HARD_EXACT, ENV_DENY_PREFIX];\n",
    );
    expect(DECLARATION.test(prose.code)).toBe(false);

    // …and the same is true of the file that actually shipped.
    const real = sources.find((s) => s.path === "packages/core/src/worker/env.ts");
    expect(real).toBeDefined();
    expect(DECLARATION.test(real?.code ?? "")).toBe(false);
    expect(real?.code).toContain("ENV_DENY_EXACT");
  });
});
