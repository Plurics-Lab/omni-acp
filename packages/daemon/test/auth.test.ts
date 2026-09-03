import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  DaemonConfig,
  HEADER,
  OmniError,
  hashSecret,
  type ResolvedDaemonConfig,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { createTokenStore } from "../src/auth.js";

const SECRET = "user-secret-value-0123456789";
const ADMIN_SECRET = "admin-secret-value-0123456789";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "omni-auth-")));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  // The directories are inside `os.tmpdir()`; the OS reclaims them. Nothing here may run `rm -rf`
  // on a path a test computed — that is the one cleanup mistake that eats a developer's disk.
  roots.length = 0;
});

function config(over?: Partial<Parameters<typeof DaemonConfig.parse>[0]>): ResolvedDaemonConfig {
  return DaemonConfig.parse({
    dataDir: tmpdir(),
    tokens: [
      { id: "user", secret: SECRET, role: "user", cwdRoots: [tmpdir()], maxWorkers: 3 },
      { id: "admin", secret: ADMIN_SECRET, role: "admin", agents: ["only-this"] },
    ],
    ...(over ?? {}),
  } as Parameters<typeof DaemonConfig.parse>[0]);
}

const bearer = (secret: string, clientId?: string): Headers =>
  new Headers({
    [HEADER.auth]: `Bearer ${secret}`,
    ...(clientId === undefined ? {} : { [HEADER.clientId]: clientId }),
  });

const snapshotOwnedBy = (ownerTokenId: string): WorkerSnapshot =>
  ({ ownerTokenId }) as WorkerSnapshot;

describe("TokenStore.verify (H13)", () => {
  it("accepts the right secret and returns that token's boundary", () => {
    const store = createTokenStore(config());
    const auth = store.verify(bearer(SECRET, "laptop"));
    expect(auth.tokenId).toBe("user");
    expect(auth.role).toBe("user");
    expect(auth.clientId).toBe("laptop");
    expect(auth.maxWorkers).toBe(3);
    expect(auth.asClientRef()).toEqual({ tokenId: "user", clientId: "laptop" });
  });

  it("rejects missing, malformed, unknown and right-prefix-wrong-secret with 401", () => {
    const store = createTokenStore(config());
    const cases: Headers[] = [
      new Headers(),
      new Headers({ [HEADER.auth]: SECRET }), // no scheme
      new Headers({ [HEADER.auth]: `Basic ${SECRET}` }),
      new Headers({ [HEADER.auth]: "Bearer " }),
      new Headers({ [HEADER.auth]: `Bearer ${SECRET}x` }),
      new Headers({ [HEADER.auth]: "Bearer unknown-secret-entirely" }),
    ];
    for (const headers of cases) {
      let thrown: unknown;
      try {
        store.verify(headers);
      } catch (e) {
        thrown = e;
      }
      expect(OmniError.is(thrown, "unauthorized")).toBe(true);
      expect((thrown as OmniError).status).toBe(401);
      // The secret must not travel back out in the message it failed with.
      expect((thrown as OmniError).message).not.toContain(SECRET);
    }
  });

  it("accepts the scheme case-insensitively and tolerates extra whitespace", () => {
    const store = createTokenStore(config());
    expect(store.verify(new Headers({ [HEADER.auth]: `bearer ${SECRET}` })).tokenId).toBe("user");
    expect(store.verify(new Headers({ [HEADER.auth]: `BEARER  ${SECRET} ` })).tokenId).toBe("user");
  });

  it("hashes a plaintext secret at load and drops it from the config object", () => {
    const cfg = config();
    createTokenStore(cfg);
    for (const token of cfg.tokens) {
      expect(token.secret).toBeUndefined();
      expect(token.secretSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(cfg.tokens[0]?.secretSha256).toBe(hashSecret(SECRET));
  });

  it("accepts a token configured as a digest, with no plaintext anywhere", () => {
    const cfg = DaemonConfig.parse({
      tokens: [{ id: "hashed", secretSha256: hashSecret(SECRET) }],
    });
    expect(createTokenStore(cfg).verify(bearer(SECRET)).tokenId).toBe("hashed");
  });

  it("is re-evaluated per call: mutating the token table changes the next verdict", () => {
    // DESIGN §8 — "每次都查、不缓存决策". No restart, no reload hook, no cached verdict.
    const cfg = config();
    const store = createTokenStore(cfg);
    expect(store.verify(bearer(SECRET)).tokenId).toBe("user");

    cfg.tokens = cfg.tokens.filter((t) => t.id !== "user");
    expect(() => store.verify(bearer(SECRET))).toThrow(/unknown bearer token/);
    expect(store.has("user")).toBe(false);

    cfg.tokens.push({
      id: "fresh",
      secret: "another-secret-0123456789",
      role: "user",
      agents: "*",
      cwdRoots: [],
      maxWorkers: 1,
    });
    expect(store.verify(bearer("another-secret-0123456789")).tokenId).toBe("fresh");
    // …and the plaintext of the token added at runtime is dropped just the same.
    expect(cfg.tokens.find((t) => t.id === "fresh")?.secret).toBeUndefined();
  });

  it("rejects an Omni-Client-Id longer than the audit bound", () => {
    const store = createTokenStore(config());
    expect(() => store.verify(bearer(SECRET, "x".repeat(201)))).toThrow(/Omni-Client-Id/);
  });

  it("refuses a config with two tokens sharing an id", () => {
    const cfg = DaemonConfig.parse({
      tokens: [
        { id: "same", secret: SECRET },
        { id: "same", secret: ADMIN_SECRET },
      ],
    });
    expect(() => createTokenStore(cfg)).toThrow(/duplicate token id/);
  });
});

describe("TokenStore.contextFor (review R10 — the in-process path)", () => {
  it("returns the same boundary as verify(), with no header in sight", () => {
    const store = createTokenStore(config());
    const viaHeader = store.verify(bearer(ADMIN_SECRET));
    const inProcess = store.contextFor("admin");
    expect(inProcess.tokenId).toBe(viaHeader.tokenId);
    expect(inProcess.role).toBe("admin");
    expect(inProcess.agents).toEqual(["only-this"]);
    expect(inProcess.clientId).toBeNull();
    expect(store.contextFor("admin", "vscode").clientId).toBe("vscode");
  });

  it("throws unauthorized for an unknown token id", () => {
    const store = createTokenStore(config());
    expect(() => store.contextFor("nobody")).toThrow(OmniError);
    try {
      store.contextFor("nobody");
    } catch (e) {
      expect(OmniError.is(e, "unauthorized")).toBe(true);
    }
  });
});

describe("AuthContext.assertAgent (H14)", () => {
  it('allows everything under agents: "*"', () => {
    const auth = createTokenStore(config()).contextFor("user");
    expect(auth.agents).toBe("*");
    expect(() => auth.assertAgent("anything")).not.toThrow();
  });

  it("forbids an agent outside the allowlist with 403, not 404", () => {
    const auth = createTokenStore(config()).contextFor("admin");
    expect(() => auth.assertAgent("only-this")).not.toThrow();
    try {
      auth.assertAgent("something-else");
      expect.unreachable();
    } catch (e) {
      expect(OmniError.is(e, "forbidden")).toBe(true);
      expect((e as OmniError).status).toBe(403);
    }
  });
});

describe("AuthContext.assertCwd (D18, H14)", () => {
  it("returns the canonical cwd for a path inside a root", async () => {
    const root = await tempRoot();
    const inside = join(root, "project");
    await mkdir(inside);
    const auth = createTokenStore(
      DaemonConfig.parse({ tokens: [{ id: "t", secret: SECRET, cwdRoots: [root] }] }),
    ).contextFor("t");
    expect(await auth.assertCwd(inside)).toBe(await realpath(inside));
  });

  it("accepts the root itself and rejects a sibling that merely shares a prefix", async () => {
    const root = await tempRoot();
    const sibling = `${root}-evil`;
    await mkdir(sibling);
    roots.push(sibling);
    const auth = createTokenStore(
      DaemonConfig.parse({ tokens: [{ id: "t", secret: SECRET, cwdRoots: [root] }] }),
    ).contextFor("t");
    expect(await auth.assertCwd(root)).toBe(root);
    await expect(auth.assertCwd(sibling)).rejects.toThrow(/outside every allowed root/);
  });

  it("rejects an absent path rather than guessing, with 403", async () => {
    const root = await tempRoot();
    const auth = createTokenStore(
      DaemonConfig.parse({ tokens: [{ id: "t", secret: SECRET, cwdRoots: [root] }] }),
    ).contextFor("t");
    try {
      await auth.assertCwd(join(root, "does-not-exist"));
      expect.unreachable();
    } catch (e) {
      expect(OmniError.is(e, "forbidden")).toBe(true);
      expect((e as OmniError).status).toBe(403);
    }
  });

  it("rejects `..` traversal out of the root", async () => {
    const root = await tempRoot();
    await expect(
      createTokenStore(
        DaemonConfig.parse({ tokens: [{ id: "t", secret: SECRET, cwdRoots: [root] }] }),
      )
        .contextFor("t")
        .assertCwd(join(root, "..")),
    ).rejects.toThrow(/outside every allowed root/);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a SYMLINK inside the root that points outside it — realpath first, containment second",
    async () => {
      const root = await tempRoot();
      const outside = await tempRoot();
      const escape = join(root, "escape");
      await symlink(outside, escape, "dir");

      const auth = createTokenStore(
        DaemonConfig.parse({ tokens: [{ id: "t", secret: SECRET, cwdRoots: [root] }] }),
      ).contextFor("t");

      // A string comparison would pass this: the path literally starts with the root.
      expect(escape.startsWith(root)).toBe(true);
      await expect(auth.assertCwd(escape)).rejects.toThrow(/outside every allowed root/);
    },
  );

  it.skipIf(process.platform === "win32")(
    "canonicalises the ROOT too, so a symlinked root does not reject its own contents",
    async () => {
      const real = await tempRoot();
      const link = join(await tempRoot(), "link-to-root");
      await symlink(real, link, "dir");
      const inside = join(real, "work");
      await mkdir(inside);

      // The root is configured through the symlink (this is macOS's /tmp -> /private/tmp).
      const auth = createTokenStore(
        DaemonConfig.parse({ tokens: [{ id: "t", secret: SECRET, cwdRoots: [link] }] }),
      ).contextFor("t");
      expect(await auth.assertCwd(inside)).toBe(await realpath(inside));
    },
  );

  it("defaults cwdRoots to the home directory when the config leaves it empty", () => {
    const auth = createTokenStore(
      DaemonConfig.parse({ tokens: [{ id: "t", secret: SECRET }] }),
    ).contextFor("t");
    expect(auth.cwdRoots).toEqual([homedir()]);
  });
});

describe("AuthContext.canSee (D13)", () => {
  it("shows a user only its own workers and an admin everything", () => {
    const store = createTokenStore(config());
    const user = store.contextFor("user");
    const admin = store.contextFor("admin");

    expect(user.canSee(snapshotOwnedBy("user"))).toBe(true);
    expect(user.canSee(snapshotOwnedBy("admin"))).toBe(false);
    expect(admin.canSee(snapshotOwnedBy("user"))).toBe(true);
    expect(admin.canSee(snapshotOwnedBy("admin"))).toBe(true);
  });
});
