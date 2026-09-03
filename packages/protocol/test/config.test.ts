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
        },
      ],
      agents: [],
      maxWorkers: 64,
      eventLog: {
        driver: "memory",
        maxEventsPerWorker: 10_000,
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
      },
      turn: { quietMs: 250, hardMs: 5_000, cancelGraceMs: 10_000 },
      logLevel: "info",
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

  it('rejects an unknown key, a non-empty mcp, and onUnresolved:"park"', () => {
    const base = { agent: "example", cwd: "/tmp/x" };
    expect(CreateWorkerRequest.safeParse({ ...base, env: { A: "1" } }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, policy: {} }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, mcp: ["fs"] }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, onUnresolved: "park" }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, onUnresolved: "fail" }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, timeoutMs: 999 }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ ...base, timeoutMs: 600_001 }).success).toBe(false);
    expect(CreateWorkerRequest.safeParse({ agent: "", cwd: "/tmp" }).success).toBe(false);
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

  it("rejects every non-text block, an empty array and unknown keys (H8 -> 400)", () => {
    expect(
      PromptRequestBody.safeParse({
        content: [{ type: "resource_link", uri: "file:///etc/passwd" }],
      }).success,
    ).toBe(false);
    expect(PromptRequestBody.safeParse({ content: [{ type: "image", data: "…" }] }).success).toBe(
      false,
    );
    expect(PromptRequestBody.safeParse({ content: [] }).success).toBe(false);
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
