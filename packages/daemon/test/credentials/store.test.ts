import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DaemonConfig,
  OmniError,
  type AuthContext,
  type DaemonConfig as DaemonConfigInput,
} from "@omni-acp/protocol";
import { fakeClock, nullLogger } from "@omni-acp/testkit";
import { createCatalog } from "../../src/catalog.js";
import { createTokenStore } from "../../src/auth.js";
import { createCredentialStore, transportIsSecure } from "../../src/credentials/store.js";
import { credentialDir, filesDir, metaPath, secretPath } from "../../src/credentials/paths.js";
import { removeTempRoots, tempRoot } from "../support/temp-dirs.js";

/**
 * The credential store (docs/M3-WP1-CREDENTIALS.md §凭据仓库).
 *
 * Every case here is about one of the three rules the store exists to keep, and each of them is
 * asserted on the FILESYSTEM rather than on a return value wherever the filesystem is the claim:
 *
 *  1. modes — 0700 on every directory, 0600 on every file;
 *  2. ownership is the PATH — a second token's read cannot reach the first's tree;
 *  3. secrets only go UP — no method here returns one, and `fingerprint` is 12 hex characters.
 *
 * Owned by M3-WP1.
 */

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);
const SECRET_ADMIN = "c".repeat(32);

/** A real claude-acp-shaped credential, with the `expiresAt` the real file carries (E1). */
function claudeCredential(expiresAtMs: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-PLANTED-ACCESS",
      refreshToken: "sk-ant-ort01-PLANTED-REFRESH",
      expiresAt: expiresAtMs,
      subscriptionType: "max",
    },
  });
}

interface Rig {
  readonly dataDir: string;
  readonly store: ReturnType<typeof createCredentialStore>;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly a: AuthContext;
  readonly b: AuthContext;
  readonly admin: AuthContext;
  readonly linked: { rows: { workerId: string; reload: "file" | "restart" }[] };
}

async function rig(o?: { listenHost?: string | null; allowInsecure?: boolean }): Promise<Rig> {
  const root = await tempRoot("omni-credstore-");
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });

  const input: DaemonConfigInput = {
    dataDir,
    listen: o?.listenHost === null ? null : { host: o?.listenHost ?? "127.0.0.1", port: 0 },
    tokens: [
      { id: "a", secret: SECRET_A, cwdRoots: [root] },
      { id: "b", secret: SECRET_B, cwdRoots: [root] },
      { id: "admin", secret: SECRET_ADMIN, role: "admin", cwdRoots: [root] },
    ],
    agents: [
      // `claude-acp` by id, so `selectBuiltin` picks the real builtin and the store sees the real
      // credential contract — the file name allowlist and the token/apiKey variables are all
      // descriptor data, and a fake descriptor would assert nothing about the shipped one.
      { id: "claude-acp", command: process.execPath, args: ["-e", ""] },
      { id: "codex-acp", command: process.execPath, args: ["-e", ""] },
      // An agent with NO builtin profile, i.e. no credential contract at all.
      { id: "plain", command: process.execPath, args: ["-e", ""] },
    ],
    ...(o?.allowInsecure === true ? { credentials: { allowInsecureTransport: true } } : {}),
    logLevel: "silent",
  };
  const config = DaemonConfig.parse(input);
  const clock = fakeClock();
  const tokens = createTokenStore(config);
  const catalog = createCatalog(config);
  const linked = { rows: [] as { workerId: string; reload: "file" | "restart" }[] };
  const store = createCredentialStore({
    dataDir,
    config,
    catalog,
    clock,
    logger: nullLogger(),
    hooks: { linked: () => linked.rows as never },
  });
  return {
    dataDir,
    store,
    clock,
    a: tokens.contextFor("a", null),
    b: tokens.contextFor("b", null),
    admin: tokens.contextFor("admin", null),
    linked,
  };
}

const thrown = async (work: Promise<unknown>): Promise<OmniError> => {
  try {
    await work;
  } catch (e) {
    if (e instanceof OmniError) return e;
    throw new Error(`expected an OmniError, got ${String(e)}`, { cause: e });
  }
  throw new Error("expected a rejection, got a value");
};

const mode = async (path: string): Promise<string> =>
  ((await lstat(path)).mode & 0o777).toString(8);

afterEach(async () => {
  await removeTempRoots();
});

describe("createCredentialStore — the modes, and they are asserted on the filesystem", () => {
  // POSIX-only permission assertions; the functional credential tests still run on Windows.
  it.skipIf(process.platform === "win32")(
    "writes every directory 0700 and every file 0600",
    async () => {
      const r = await rig();
      await r.store.put(r.a, "claude-acp", "default", {
        kind: "files",
        files: { ".credentials.json": claudeCredential(Date.now() + 3_600_000) },
      });

      const dir = credentialDir(r.dataDir, "a", "claude-acp", "default");
      // 0700 all the way down, so another local account cannot even LIST the tree — which is the
      // posture `ids-file.ts`, `probe-cache.ts` and the data dir itself already take.
      expect(await mode(join(r.dataDir, "credentials"))).toBe("700");
      expect(await mode(join(r.dataDir, "credentials", "a"))).toBe("700");
      expect(await mode(dir)).toBe("700");
      expect(await mode(filesDir(dir))).toBe("700");
      expect(await mode(join(filesDir(dir), ".credentials.json"))).toBe("600");
      expect(await mode(metaPath(dir))).toBe("600");
    },
  );

  it("puts a token credential in its own file, at 0600, under the descriptor's variable", async () => {
    const r = await rig();
    const summary = await r.store.put(r.a, "claude-acp", "oauth", {
      kind: "token",
      token: "PLANTED-OAUTH-TOKEN",
    });
    // E5: `claude setup-token` mints a long-lived subscription token read from
    // `CLAUDE_CODE_OAUTH_TOKEN`, which is what the descriptor declares — so the store does not
    // choose the variable, the measurement does.
    expect(summary.method).toBe("token");
    expect(summary.env).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(summary.files).toEqual([]);
    const dir = credentialDir(r.dataDir, "a", "claude-acp", "oauth");
    if (process.platform !== "win32") expect(await mode(secretPath(dir))).toBe("600");
    // And `files/` does NOT exist: a token credential has no file the agent reads, and a leftover
    // one would be the file the agent prefers.
    await expect(lstat(filesDir(dir))).rejects.toThrow();
  });

  it("refuses an apiKey for a runtime that declares no variable for one", async () => {
    const r = await rig();
    // codex-acp declares `apiKeyEnv: "CODEX_API_KEY"` and NO `tokenEnv`: E5 records that
    // `codex login --with-access-token` takes the token on stdin and there is no env spelling for
    // a subscription token. So a `token` credential has nowhere to go, and the refusal says so.
    const e = await thrown(r.store.put(r.a, "codex-acp", "t", { kind: "token", token: "x" }));
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("no environment variable");
    expect(
      (await r.store.put(r.a, "codex-acp", "k", { kind: "apiKey", apiKey: "PLANTED-KEY" })).env,
    ).toBe("CODEX_API_KEY");
  });
});

describe("createCredentialStore — the fingerprint", () => {
  it("is 12 hex characters, stable under key order, and different for different content", async () => {
    const r = await rig();
    const one = await r.store.put(r.a, "claude-acp", "one", {
      kind: "files",
      files: { ".credentials.json": "{}" },
    });
    expect(one.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    // The SAME content under a different name fingerprints the same: the identity is the
    // credential, not the row. This is what makes `restartRequired` fire on a real change and not
    // on every `PUT`.
    const two = await r.store.put(r.a, "claude-acp", "two", {
      kind: "files",
      files: { ".credentials.json": "{}" },
    });
    expect(two.fingerprint).toBe(one.fingerprint);

    const changed = await r.store.put(r.a, "claude-acp", "one", {
      kind: "files",
      files: { ".credentials.json": '{"a":1}' },
    });
    expect(changed.fingerprint).not.toBe(one.fingerprint);
  });

  it("reads `expiresAt` out of the credential's own body, without a per-agent branch", async () => {
    const r = await rig();
    // MEASURED (2026-09-12): claude's `.credentials.json` carries
    // `claudeAiOauth.expiresAt` as epoch MILLISECONDS, at depth 2. Codex's `auth.json` carries no
    // expiry at all, only `last_refresh` — so the generic reader answers null for it, which is the
    // honest answer rather than a guess at what `last_refresh` means.
    const at = 1_800_000_000_000;
    const claude = await r.store.put(r.a, "claude-acp", "default", {
      kind: "files",
      files: { ".credentials.json": claudeCredential(at) },
    });
    expect(claude.expiresAt).toBe(new Date(at).toISOString());

    const codex = await r.store.put(r.a, "codex-acp", "default", {
      kind: "files",
      files: { "auth.json": JSON.stringify({ auth_mode: "chatgpt", last_refresh: "2026-09-04" }) },
    });
    expect(codex.expiresAt).toBeNull();
  });
});

describe("createCredentialStore — ownership is the PATH (D13, §凭据仓库)", () => {
  it("does not let a second token read the first's credential, and says nothing about it", async () => {
    const r = await rig();
    await r.store.put(r.a, "claude-acp", "shared-name", {
      kind: "files",
      files: { ".credentials.json": claudeCredential(Date.now() + 3_600_000) },
    });

    // `422 credential_required` and not a 404 that distinguishes "no such name here" from
    // "somebody else's": the path is built from `auth.tokenId`, so token `b`'s read never
    // constructs a path into token `a`'s tree at all.
    const e = await thrown(r.store.get(r.b, "claude-acp", "shared-name"));
    expect(e.code).toBe("credential_required");
    // The message says what THIS token has and says nothing about anybody else: no other token's
    // id, and no hint that the name exists elsewhere. It is the same sentence a name nobody has
    // ever stored produces, which is the property that matters.
    expect(e.message).not.toContain('"a"');
    expect(e.message).toBe((await thrown(r.store.get(r.b, "claude-acp", "shared-name"))).message);
    expect((await r.store.list(r.b)).credentials).toEqual([]);

    // Token `a` sees exactly its own.
    const mine = (await r.store.list(r.a)).credentials;
    expect(mine.map((c) => `${c.agentId}/${c.name}`)).toEqual(["claude-acp/shared-name"]);
    expect(mine[0]?.ownerTokenId).toBe("a");
  });

  it("lets an ADMIN list every token's credentials and read none of their contents", async () => {
    const r = await rig();
    await r.store.put(r.a, "claude-acp", "a-one", {
      kind: "files",
      files: { ".credentials.json": claudeCredential(Date.now() + 3_600_000) },
    });
    await r.store.put(r.b, "codex-acp", "b-one", {
      kind: "files",
      files: { "auth.json": '{"auth_mode":"chatgpt"}' },
    });

    const all = (await r.store.list(r.admin)).credentials;
    expect(all.map((c) => `${c.ownerTokenId}:${c.agentId}/${c.name}`).sort()).toEqual([
      "a:claude-acp/a-one",
      "b:codex-acp/b-one",
    ]);
    // D13 gives an admin the whole machine's worker fleet; it does not give them other people's
    // logins. There is no shape in a `CredentialSummary` that could carry one — which is the
    // assertion, made over the BYTES so a future field cannot quietly add one.
    expect(JSON.stringify(all)).not.toContain("PLANTED");
    expect(JSON.stringify(all)).not.toContain("sk-ant");
  });
});

describe("createCredentialStore — the in-place update (§凭据仓库: PUT 已存在的名字)", () => {
  it("keeps createdAt, moves updatedAt, and reports workersAffected + restartRequired", async () => {
    const r = await rig();
    const first = await r.store.put(r.a, "codex-acp", "default", {
      kind: "files",
      files: { "auth.json": '{"auth_mode":"chatgpt","tokens":{"access_token":"OLD"}}' },
    });
    expect(first.workersAffected).toBe(0);
    expect(first.restartRequired).toEqual([]);

    // Two live workers linked to this credential: one on a runtime that re-reads the file per
    // request (measured `reload: "file"`) and one that caches it (measured `reload: "restart"`).
    r.linked.rows = [
      { workerId: "w_file", reload: "file" },
      { workerId: "w_restart", reload: "restart" },
    ];
    r.clock.advance(5_000);

    const second = await r.store.put(r.a, "codex-acp", "default", {
      kind: "files",
      files: { "auth.json": '{"auth_mode":"chatgpt","tokens":{"access_token":"NEW"}}' },
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(second.workersAffected).toBe(2);
    /**
     * ONLY the caching one. Every live worker's home links AT the file that just changed, so the
     * `reload:"file"` worker picks the new credential up on its very next request with nothing
     * else happening — and an operator who restarted it anyway would be replacing a process for
     * no reason. The other one will keep using the OLD credential until its process is replaced,
     * which is a fact no summary could carry and the whole reason this field exists.
     */
    expect(second.restartRequired).toEqual(["w_restart"]);

    // The file on disk is the NEW one, and the store kept exactly one copy of it.
    const dir = credentialDir(r.dataDir, "a", "codex-acp", "default");
    expect(await readFile(join(filesDir(dir), "auth.json"), "utf8")).toContain("NEW");
    expect(await readdir(filesDir(dir))).toEqual(["auth.json"]);
  });

  it("removes a file a previous version of the credential had and this one does not", async () => {
    const r = await rig();
    // A two-file credential, then a one-file one. The stale file must GO: a leftover credential
    // file is the one the agent might prefer, which is an auth failure nobody could trace.
    await r.store.put(r.a, "plain", "default", {
      kind: "files",
      files: { "one.json": "{}", "two.json": "{}" },
    });
    await r.store.put(r.a, "plain", "default", { kind: "files", files: { "one.json": "{}" } });
    const dir = credentialDir(r.dataDir, "a", "plain", "default");
    expect(await readdir(filesDir(dir))).toEqual(["one.json"]);
  });
});

describe("createCredentialStore — the refusals", () => {
  it("refuses a file name the descriptor does not declare, naming what the agent reads", async () => {
    const r = await rig();
    // The descriptor's list IS the allowlist: an agent that reads `.credentials.json` has no
    // business being handed an `id_rsa`, and a store that accepted any name would be a
    // general-purpose file drop with a 0600 mode.
    const e = await thrown(
      r.store.put(r.a, "claude-acp", "default", {
        kind: "files",
        files: { id_rsa: "PRIVATE KEY" },
      }),
    );
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain(".credentials.json");
    expect(e.message).not.toContain("PRIVATE KEY");
  });

  it("refuses a name that is not a path segment, at the store as well as at the schema", async () => {
    const r = await rig();
    for (const name of ["../escape", "a/b", ".", "..", "-leading"]) {
      const e = await thrown(r.store.get(r.a, "claude-acp", name));
      expect({ name, code: e.code }).toEqual({ name, code: "bad_request" });
    }
    // And nothing was created outside the tree by trying.
    await expect(readdir(join(r.dataDir, "credentials"))).rejects.toThrow();
  });

  it("refuses a DELETE while a live worker's home links to the credential", async () => {
    const r = await rig();
    await r.store.put(r.a, "claude-acp", "default", {
      kind: "files",
      files: { ".credentials.json": claudeCredential(Date.now() + 3_600_000) },
    });
    r.linked.rows = [{ workerId: "w_live", reload: "file" }];

    const e = await thrown(r.store.remove(r.a, "claude-acp", "default"));
    expect(e.code).toBe("worker_busy");
    expect(e.detail?.["workers"]).toEqual(["w_live"]);
    // Still there: a 409 that deleted the file anyway would leave the worker's home pointing at
    // nothing, which on both real agents is an authentication failure on the next request.
    expect((await r.store.get(r.a, "claude-acp", "default")).name).toBe("default");

    r.linked.rows = [];
    await r.store.remove(r.a, "claude-acp", "default");
    expect((await thrown(r.store.get(r.a, "claude-acp", "default"))).code).toBe(
      "credential_required",
    );
  });

  it("refuses a WRITE over a transport that is neither TLS nor loopback", async () => {
    // A `PUT` is the one request body in the repository that carries a plaintext secret.
    const exposed = await rig({ listenHost: "0.0.0.0" });
    const e = await thrown(
      exposed.store.put(exposed.a, "claude-acp", "default", { kind: "token", token: "x" }),
    );
    expect(e.code).toBe("insecure_transport");
    expect(e.status).toBe(403);

    // The predicate itself, over the four shapes an operator can configure.
    const parse = (listen: { host: string; port: number } | null, allow = false) =>
      DaemonConfig.parse({
        dataDir: exposed.dataDir,
        listen,
        tokens: [{ id: "t", secret: SECRET_A }],
        ...(allow ? { credentials: { allowInsecureTransport: true } } : {}),
      });
    expect(transportIsSecure(parse({ host: "127.0.0.1", port: 0 }))).toBe(true);
    expect(transportIsSecure(parse({ host: "::1", port: 0 }))).toBe(true);
    // `listen: null` is IN-PROCESS ONLY (D15): there is no socket, so there is nothing to
    // intercept.
    expect(transportIsSecure(parse(null))).toBe(true);
    expect(transportIsSecure(parse({ host: "10.0.0.5", port: 0 }))).toBe(false);
    // The operator's escape hatch, for TLS terminating in front of the daemon.
    expect(transportIsSecure(parse({ host: "10.0.0.5", port: 0 }, true))).toBe(true);
  });

  it("refuses an agent this token may not use, BEFORE it writes anything", async () => {
    const root = await tempRoot("omni-credacl-");
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const config = DaemonConfig.parse({
      dataDir,
      listen: { host: "127.0.0.1", port: 0 },
      tokens: [{ id: "narrow", secret: SECRET_A, agents: [], cwdRoots: [root] }],
      agents: [{ id: "claude-acp", command: process.execPath, args: ["-e", ""] }],
      logLevel: "silent",
    });
    const store = createCredentialStore({
      dataDir,
      config,
      catalog: createCatalog(config),
      clock: fakeClock(),
      logger: nullLogger(),
    });
    const auth = createTokenStore(config).contextFor("narrow", null);
    const e = await thrown(store.put(auth, "claude-acp", "default", { kind: "token", token: "x" }));
    expect(e.code).toBe("forbidden");
    await expect(readdir(join(dataDir, "credentials"))).rejects.toThrow();
  });
});

describe("createCredentialStore.resolveFor — the CREATE-TIME validation (§Home 隔离)", () => {
  it("falls back to `inherit` for an OMITTED credential, which is M2's behaviour", async () => {
    const r = await rig();
    const binding = await r.store.resolveFor({
      auth: r.a,
      agentId: "claude-acp",
      requested: undefined,
      home: null,
    });
    // `credentials.allowInherit` defaults true, and this IS the backward-compatibility bar: with
    // nothing stored and `credential` omitted, a worker composes exactly the environment it
    // composed in M2.
    expect(binding).toEqual({
      name: null,
      method: "inherit",
      fingerprint: null,
      home: null,
      env: {},
    });
  });

  it("refuses an EXPLICIT name that is not stored with 422, before anything spawns", async () => {
    const r = await rig();
    const e = await thrown(
      r.store.resolveFor({
        auth: r.a,
        agentId: "claude-acp",
        requested: "missing",
        home: null,
      }),
    );
    expect(e.code).toBe("credential_required");
    expect(e.status).toBe(422);
  });

  it("refuses an EXPIRED credential with its own code and the timestamp", async () => {
    const r = await rig();
    const expiresAt = r.clock.now() + 1_000;
    await r.store.put(r.a, "claude-acp", "default", {
      kind: "files",
      files: { ".credentials.json": claudeCredential(expiresAt) },
    });
    // Still fine a moment before.
    expect(
      (
        await r.store.resolveFor({
          auth: r.a,
          agentId: "claude-acp",
          requested: "default",
          home: null,
        })
      ).method,
    ).toBe("files");

    r.clock.advance(2_000);
    const e = await thrown(
      r.store.resolveFor({ auth: r.a, agentId: "claude-acp", requested: "default", home: null }),
    );
    // A DIFFERENT code from `credential_required`, because the fix is different: one says "store a
    // credential", the other says "store a NEWER one".
    expect(e.code).toBe("credential_expired");
    expect(e.status).toBe(422);
    expect(e.message).toContain(new Date(expiresAt).toISOString());
  });

  it("composes the home variable and the token variable, and nothing else", async () => {
    const r = await rig();
    await r.store.put(r.a, "claude-acp", "oauth", { kind: "token", token: "PLANTED-OAUTH" });
    const binding = await r.store.resolveFor({
      auth: r.a,
      agentId: "claude-acp",
      requested: "oauth",
      home: "/tmp/home-x",
    });
    expect(binding.env).toEqual({
      CLAUDE_CONFIG_DIR: "/tmp/home-x",
      CLAUDE_CODE_OAUTH_TOKEN: "PLANTED-OAUTH",
    });
    // The secret is in `env` because something has to spawn the process — and NOWHERE else on the
    // binding, which is what reaches a snapshot.
    expect(JSON.stringify({ ...binding, env: undefined })).not.toContain("PLANTED");
  });

  it("gives the `none` sentinel an EMPTY home with the home variable still set", async () => {
    const r = await rig();
    const binding = await r.store.resolveFor({
      auth: r.a,
      agentId: "claude-acp",
      requested: "none",
      home: "/tmp/home-none",
    });
    // The home variable IS set and no credential is linked: that is what makes the worker
    // demonstrably unauthenticated rather than quietly borrowing the daemon's own login.
    expect(binding).toEqual({
      name: null,
      method: "none",
      fingerprint: null,
      home: "/tmp/home-none",
      env: { CLAUDE_CONFIG_DIR: "/tmp/home-none" },
    });
  });

  it("refuses `inherit` when the operator turned it off", async () => {
    const root = await tempRoot("omni-credinherit-");
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const config = DaemonConfig.parse({
      dataDir,
      listen: { host: "127.0.0.1", port: 0 },
      tokens: [{ id: "a", secret: SECRET_A, cwdRoots: [root] }],
      agents: [{ id: "claude-acp", command: process.execPath, args: ["-e", ""] }],
      credentials: { allowInherit: false },
      logLevel: "silent",
    });
    const store = createCredentialStore({
      dataDir,
      config,
      catalog: createCatalog(config),
      clock: fakeClock(),
      logger: nullLogger(),
    });
    const auth = createTokenStore(config).contextFor("a", null);
    // Both spellings: the explicit sentinel and the omitted-with-nothing-stored fallback.
    for (const requested of ["inherit", undefined]) {
      const e = await thrown(
        store.resolveFor({ auth, agentId: "claude-acp", requested, home: null }),
      );
      expect({ requested, code: e.code }).toEqual({ requested, code: "credential_required" });
    }
  });

  it("answers `inherit` for a runtime that declares NO credential contract", async () => {
    const r = await rig();
    // `plain` matches no builtin, so `credentials` is null on its descriptor: there is no home
    // variable to set and no file to link, and the only honest answer is the daemon's environment.
    expect(r.store.contractFor("plain")).toBeNull();
    expect(
      await r.store.resolveFor({ auth: r.a, agentId: "plain", requested: undefined, home: null }),
    ).toMatchObject({ method: "inherit", home: null });
    // And naming a credential for it is a `bad_request` rather than a silent inherit: the caller
    // asked for something the runtime cannot express.
    const e = await thrown(
      r.store.resolveFor({ auth: r.a, agentId: "plain", requested: "default", home: null }),
    );
    expect(e.code).toBe("bad_request");
    expect(e.message).toContain("no credential contract");
  });
});

describe("createCredentialStore.check / loginFor — the LIGHT check (§探测)", () => {
  it("answers ok / expired / required off the FILE, never off a handshake", async () => {
    const r = await rig();
    // Why the file: MEASURED on claude-acp 0.73.0, `initialize.authMethods` is `[]` and
    // `session/new` SUCCEEDS with no credential, a garbage one and a valid one alike — only
    // `session/prompt` tells them apart. So a light check that handshook would learn nothing and
    // cost a process.
    const missing = await r.store.check(r.a, "claude-acp", "default", {});
    expect(missing.state).toBe("required");
    expect(missing.deep).toBe(false);

    const expiresAt = r.clock.now() + 10_000;
    await r.store.put(r.a, "claude-acp", "default", {
      kind: "files",
      files: { ".credentials.json": claudeCredential(expiresAt) },
    });
    const ok = await r.store.check(r.a, "claude-acp", "default", {});
    expect(ok.state).toBe("ok");
    expect(ok.method).toBe("files");
    expect(ok.expiresAt).toBe(new Date(expiresAt).toISOString());
    expect(ok.fingerprint).toMatch(/^[0-9a-f]{12}$/);

    r.clock.advance(20_000);
    expect((await r.store.check(r.a, "claude-acp", "default", {})).state).toBe("expired");
  });

  it("answers the light check when `deep` is asked for and no deep check is wired", async () => {
    const r = await rig();
    await r.store.put(r.a, "claude-acp", "default", {
      kind: "files",
      files: { ".credentials.json": claudeCredential(r.clock.now() + 10_000) },
    });
    const answer = await r.store.check(r.a, "claude-acp", "default", { deep: true });
    // D29's honest answer: `deep` was asked for and could not be done, so the reply SAYS
    // `deep: false` rather than dressing the light verdict up as a deep one.
    expect(answer.deep).toBe(false);
    expect(answer.state).toBe("ok");
    expect(answer.detail).toContain("without a deep credential check");
  });

  it("loginFor reports `unknown` for a contract-less runtime and never rejects", async () => {
    const r = await rig();
    // `GET /v1/agents` serves this for every configured agent, including ones this token may not
    // use, so a failure here would break the whole catalogue over one row.
    expect(await r.store.loginFor(r.a, "plain")).toMatchObject({ state: "unknown" });
    expect(await r.store.loginFor(r.a, "not-configured-at-all")).toMatchObject({
      state: "unknown",
    });
    await r.store.put(r.a, "claude-acp", "default", {
      kind: "files",
      files: { ".credentials.json": claudeCredential(r.clock.now() + 10_000) },
    });
    expect(await r.store.loginFor(r.a, "claude-acp")).toMatchObject({
      state: "ok",
      credential: "default",
    });
  });
});

describe("createCredentialStore — a hand-written tree is data, not a crash", () => {
  it("ignores a credential directory with no meta.json", async () => {
    const r = await rig();
    // A boot that crashed mid-write, or somebody's `mkdir`. A directory with no meta is a
    // half-written credential and is not a credential: it must not appear in a listing and it must
    // not resolve.
    const dir = credentialDir(r.dataDir, "a", "claude-acp", "halfwritten");
    await mkdir(filesDir(dir), { recursive: true });
    await writeFile(join(filesDir(dir), ".credentials.json"), "{}");
    expect((await r.store.list(r.a)).credentials).toEqual([]);
    expect((await thrown(r.store.get(r.a, "claude-acp", "halfwritten"))).code).toBe(
      "credential_required",
    );
  });
});
