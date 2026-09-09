import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AgentDescriptor,
  CreateWorkerRequest,
  DaemonConfig,
  PromptRequestBody,
  TokenConfig,
  hashSecret,
  verifySecret,
} from "@omni-acp/protocol";

const SECRET = "s3cret-s3cret-s3cret";

describe("DaemonConfig", () => {
  it("yields EVERY default documented in CONTRACTS.md §5.1 from a bare token list", () => {
    expect(DaemonConfig.parse({ tokens: [{ id: "t1", secret: SECRET }] })).toStrictEqual({
      dataDir: "~/.omni-acp",
      listen: null,
      tokens: [
        {
          id: "t1",
          secret: SECRET,
          role: "user",
          agents: "*",
          cwdRoots: [],
          maxWorkers: 16,
          // ── M2 (§5.8.7). Both MCP and policy default FAIL CLOSED where it matters: a token
          // gets `mcpPresets: []` (an MCP server is arbitrary code on this machine, DESIGN §8's
          // 🔴) and `envAllow: []`, while `policyPresets` stays `"*"` because a preset is only
          // ever a NARROWING of what `policyCeiling: null` already permits.
          policyCeiling: null,
          policyPresets: "*",
          mcpPresets: [],
          envAllow: [],
        },
      ],
      agents: [],
      maxWorkers: 64,
      eventLog: {
        // STILL "memory" by default (ruling M1-R17): `omni-acp start` writes "sqlite" into the
        // config it builds; `createDaemon()` keeps a zero-file, zero-experimental-module
        // footprint so `OmniACP.local()` in a user's script leaves no database behind.
        driver: "memory",
        maxEventsPerWorker: 10_000,
        maxPersistedEventsPerWorker: 200_000,
        retentionDays: 7,
        retentionSweepMs: 3_600_000,
        synchronous: "normal",
        suppressExperimentalWarning: true,
        subscriberQueueSize: 1_024,
        sseHeartbeatMs: 15_000,
      },
      handshakeTimeoutMs: 60_000,
      supervisor: {
        gracefulMs: 5_000,
        killConfirmMs: 2_000,
        exitGraceMs: 1_000,
        maxFrameBytes: 32 * 1024 * 1024,
        stderrTailBytes: 32 * 1024,
        allowShimLaunch: false,
        windowsHide: true,
        reapOrphans: "fingerprint",
      },
      turn: { quietMs: 250, hardMs: 5_000, cancelGraceMs: 10_000, drainGraceMs: 2_000 },
      hibernate: {
        idleMs: 1_800_000,
        wakeTimeoutMs: 90_000,
        // Hibernating a worker you can never wake turns a healthy worker into a guaranteed 422
        // on a timer, so the default REFUSES rather than closes (ruling M1-R15).
        whenNotResumable: "keep",
        maxWakeFailures: 3,
        maxHibernated: 256,
      },
      lease: {
        ttlMs: 900_000,
        renewOnUse: true,
        stealAfterIdleMs: 0,
        // Default false, so raw curl and `curl-shapes.itest.ts` keep working; the SDK mints a
        // ULID per `connect()` (§16.1 rule L4).
        requireClientId: false,
      },
      probe: {
        onStart: "cached",
        ttlHours: 168,
        timeoutMs: 90_000,
        maxConcurrent: 2,
        deep: true,
      },
      resume: { replay: "mark_all" },
      logLevel: "info",
      // ── M2 (§5.8.7). Every block DEFAULTS, which is Land exit criterion 2: an unmodified M1
      // config file still parses, and it parses into exactly this.
      policy: { presets: {}, default: "deny-all" },
      mcpServers: {},
      watchdog: {
        enabled: true,
        // DESIGN §7's two budgets. `toolMs` is the LARGER because F36 says an open tool call can
        // be a permanent condition — `npm install` silent for 20 minutes is normal.
        silentMs: 300_000,
        toolMs: 1_800_000,
        cancelTimeoutMs: 60_000,
        action: "cancel",
      },
      interaction: {
        parkTimeoutMs: 600_000,
        // Never `"allow"`: an auto-allow on a timer is a remote-execution primitive whose only
        // guard is a clock (ruling M2-R7).
        parkTimeoutAction: "deny",
        // D4 rule 3 is absolute for the daemon unless an operator says otherwise (F26).
        allowAlways: "never",
        maxParked: 8,
        // D10, narrowed: no `url` elicitation — there is no browser here (§5.8.7).
        declareUrlElicitation: false,
      },
      diff: { provider: "none", mode: "on_write", timeoutMs: 15_000, maxBytes: 4 * 1024 * 1024 },
      webhooks: {
        // FAIL CLOSED on the daemon's first OUTBOUND surface: disabled, and `allowlist` with an
        // empty `allow` even once it is enabled.
        enabled: false,
        backoffMs: [0, 30_000, 120_000, 600_000, 1_800_000, 7_200_000],
        jitter: 0.1,
        timeoutMs: 10_000,
        maxConcurrent: 4,
        retentionDays: 30,
        secrets: {},
        mode: "allowlist",
        allow: [],
        denyCidrs: [
          "127.0.0.0/8",
          "::1/128",
          "169.254.0.0/16",
          "fe80::/10",
          "10.0.0.0/8",
          "172.16.0.0/12",
          "192.168.0.0/16",
          "fc00::/7",
        ],
        maxBodyBytes: 64 * 1024,
      },
      run: { maxConcurrent: 16, maxDurationMs: 3_600_000, retentionDays: 30 },
      envDeny: [],
    });
  });

  it("leaves `daemonId` absent rather than undefined when it is not supplied", () => {
    // It is generated and persisted to dataDir by the daemon; a key that appears as
    // `undefined` would round-trip through JSON as a missing key anyway.
    expect("daemonId" in DaemonConfig.parse({ tokens: [{ id: "t1", secret: SECRET }] })).toBe(
      false,
    );
  });

  it("requires at least one token and rejects unknown top-level keys", () => {
    expect(DaemonConfig.safeParse({ tokens: [] }).success).toBe(false);
    expect(DaemonConfig.safeParse({}).success).toBe(false);
    expect(DaemonConfig.safeParse({ tokens: [{ id: "t", secret: SECRET }], nope: 1 }).success).toBe(
      false,
    );
  });

  it('parses eventLog.driver:"sqlite" — the shape is M1-ready, the runtime rejects it', () => {
    // CONTRACTS.md §8.1: the config shape must not change in M1, so "sqlite" is accepted by the
    // schema and refused by createDaemon (WP-5). Parsing it here is the seam, not a feature.
    const cfg = DaemonConfig.parse({
      tokens: [{ id: "t", secret: SECRET }],
      eventLog: { driver: "sqlite" },
    });
    expect(cfg.eventLog.driver).toBe("sqlite");
  });

  it("defaults the nested blocks through .prefault so a partial override keeps siblings", () => {
    const cfg = DaemonConfig.parse({
      tokens: [{ id: "t", secret: SECRET }],
      supervisor: { gracefulMs: 1 },
      turn: { quietMs: 0 },
      listen: { port: 0 },
    });
    expect(cfg.supervisor.gracefulMs).toBe(1);
    expect(cfg.supervisor.killConfirmMs).toBe(2_000);
    expect(cfg.turn.quietMs).toBe(0);
    expect(cfg.turn.hardMs).toBe(5_000);
    expect(cfg.listen).toStrictEqual({ host: "127.0.0.1", port: 0 });
  });
});

describe("TokenConfig", () => {
  it("takes exactly one of secret / secretSha256", () => {
    expect(TokenConfig.safeParse({ id: "t", secret: SECRET }).success).toBe(true);
    expect(TokenConfig.safeParse({ id: "t", secretSha256: hashSecret(SECRET) }).success).toBe(true);
    // Both together is a LOAD error: which one wins would otherwise be a silent decision.
    expect(
      TokenConfig.safeParse({ id: "t", secret: SECRET, secretSha256: hashSecret(SECRET) }).success,
    ).toBe(false);
    expect(TokenConfig.safeParse({ id: "t" }).success).toBe(false);
  });

  it("refuses a short secret and a malformed digest", () => {
    expect(TokenConfig.safeParse({ id: "t", secret: "short" }).success).toBe(false);
    expect(TokenConfig.safeParse({ id: "t", secretSha256: "not-hex" }).success).toBe(false);
    expect(TokenConfig.safeParse({ id: "t", secretSha256: "A".repeat(64) }).success).toBe(false);
  });
});

describe("AgentDescriptor", () => {
  it("defaults args, env, protocolVersion and the shutdown block", () => {
    expect(AgentDescriptor.parse({ id: "example", command: "/usr/bin/node" })).toStrictEqual({
      id: "example",
      command: "/usr/bin/node",
      args: [],
      env: {},
      protocolVersion: 1,
      shutdown: { signal: "SIGTERM", graceMs: 5_000 },
      // The operator's overlay on the builtin Runtime descriptor, and the per-agent probe
      // overrides — both empty, because an unspecified overlay must not override anything.
      runtime: {},
      probe: {},
    });
  });
});

describe("CreateWorkerRequest", () => {
  it("accepts the M0 request shape", () => {
    expect(
      CreateWorkerRequest.parse({
        agent: "example",
        cwd: "/tmp/x",
        label: "one",
        mcp: [],
        onUnresolved: "deny",
        timeoutMs: 60_000,
      }),
    ).toStrictEqual({
      agent: "example",
      cwd: "/tmp/x",
      label: "one",
      mcp: [],
      onUnresolved: "deny",
      timeoutMs: 60_000,
    });
  });

  /**
   * M2 OPENS the three fields M0 shut (§5.8.6). What is still refused is what a client may never
   * express at all: an unknown key, and — the load-bearing one — anything that would let a body
   * name an MCP *command* rather than a preset NAME (DESIGN §8's 🔴, enforced by the TYPE).
   */
  it("rejects an unknown key, and accepts M2's mcp names / policy / env / park", () => {
    const base = { agent: "example", cwd: "/tmp/x" };
    expect(CreateWorkerRequest.safeParse({ ...base, env: { A: "1" } }).success).toBe(true);
    expect(CreateWorkerRequest.safeParse({ ...base, policy: "readonly" }).success).toBe(true);
    expect(CreateWorkerRequest.safeParse({ ...base, mcp: ["fs"] }).success).toBe(true);
    expect(CreateWorkerRequest.safeParse({ ...base, onUnresolved: "park" }).success).toBe(true);
    expect(CreateWorkerRequest.safeParse({ ...base, onUnresolved: "fail" }).success).toBe(true);
    // A preset NAME is a string. A command is not expressible, at any depth.
    expect(
      CreateWorkerRequest.safeParse({ ...base, mcp: [{ command: "npx", args: [] }] }).success,
    ).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, nope: 1 }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, onUnresolved: "allow" }).success).toBe(false);
    // Ruling M2-R7: `parkTimeoutAction` has no `"allow"` — an auto-allow on a timer is a
    // remote-execution primitive whose only guard is a clock.
    expect(CreateWorkerRequest.safeParse({ ...base, parkTimeoutAction: "allow" }).success).toBe(
      false,
    );
    expect(CreateWorkerRequest.safeParse({ ...base, timeoutMs: 999 }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, timeoutMs: 600_001 }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ agent: "", cwd: "/tmp" }).success).toBe(false);
  });

  it('defaults onUnresolved to "deny" — M1\'s behaviour, and the only fail-closed value', () => {
    expect(CreateWorkerRequest.parse({ agent: "example", cwd: "/tmp/x" }).onUnresolved).toBe(
      "deny",
    );
  });
});

describe("PromptRequestBody", () => {
  it("accepts text blocks verbatim, with their unknown fields intact", () => {
    const parsed = PromptRequestBody.parse({
      content: [{ type: "text", text: "who are you?", _meta: { trace: "abc" } }],
    });
    expect(parsed.content[0]).toStrictEqual({
      type: "text",
      text: "who are you?",
      _meta: { trace: "abc" },
    });
  });

  /**
   * H28 (§5.8.6). The text-only `.refine` is DELETED, not widened, and the check MOVED into
   * `WorkerRegistry.prompt()` → `assertPromptContent()` — the only layer that holds this agent's
   * `promptCapabilities` and this token's `cwdRoots`, both of which DESIGN §5.1 requires.
   *
   * So the SCHEMA now accepts a `resource_link`, and the 400 still comes back: from the worker.
   * `assert-prompt-content-is-called` is the guard that keeps the move honest, because a schema
   * that silently stopped enforcing containment looks exactly like one that got more capable.
   */
  it("no longer decides block TYPES — that moved to assertPromptContent (H28)", () => {
    expect(
      PromptRequestBody.safeParse({
        content: [{ type: "resource_link", uri: "file:///etc/passwd" }],
      }).success,
    ).toBe(true);
    expect(PromptRequestBody.safeParse({ content: [{ type: "image", data: "…" }] }).success).toBe(
      true,
    );
  });

  it("still rejects an empty array, an over-long one and unknown keys (H8 -> 400)", () => {
    expect(PromptRequestBody.safeParse({ content: [] }).success).toBe(false);
    expect(
      PromptRequestBody.safeParse({
        content: Array.from({ length: 65 }, () => ({ type: "text", text: "x" })),
      }).success,
    ).toBe(false);
    expect(
      PromptRequestBody.safeParse({ content: [{ type: "text", text: "hi" }], stream: true })
        .success,
    ).toBe(false);
  });
});

describe("secret hashing", () => {
  it("hashSecret is a plain sha256 hex digest", () => {
    expect(hashSecret("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
    expect(hashSecret(SECRET)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifySecret accepts the matching digest and nothing else", () => {
    const digest = hashSecret(SECRET);
    expect(verifySecret(SECRET, digest)).toBe(true);
    expect(verifySecret(SECRET, digest.toUpperCase())).toBe(true);
    expect(verifySecret(`${SECRET} `, digest)).toBe(false);
    expect(verifySecret("", digest)).toBe(false);
    // A malformed or truncated stored digest is `false`, never a throw: it arrives from config.
    expect(verifySecret(SECRET, "")).toBe(false);
    expect(verifySecret(SECRET, digest.slice(0, 32))).toBe(false);
    expect(verifySecret(SECRET, "zz")).toBe(false);
  });

  it("compares with timingSafeEqual, not ===", () => {
    // The property that matters is not observable from the outside in a reliable, non-flaky
    // way, so it is asserted where it lives: config.ts must import it from node:crypto.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "config.ts"),
      "utf8",
    );
    expect(src).toMatch(/import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*"node:crypto"/);
    const body = src.slice(src.indexOf("export function verifySecret"));
    expect(body).toContain("timingSafeEqual");
    expect(body).not.toMatch(/===\s*sha256Hex/);
  });
});
