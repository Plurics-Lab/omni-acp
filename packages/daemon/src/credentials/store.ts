import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  OmniError,
  type AuthContext,
  type Clock,
  type CredentialBinding,
  type CredentialCheckBody,
  type CredentialInput,
  type CredentialListResponse,
  type CredentialPutResult,
  type CredentialStore,
  type CredentialSummary,
  type LoginState,
  type Logger,
  type ResolvedDaemonConfig,
  type RuntimeCredentials,
  type TokenId,
  type WorkerId,
} from "@omni-acp/protocol";
import type { Catalog } from "../types.js";
import {
  DEFAULT_CREDENTIAL,
  DIR_MODE,
  FILE_MODE,
  INHERIT,
  NONE,
  agentRoot,
  credentialDir,
  credentialsRoot,
  expiresAtOf,
  filesDir,
  fingerprintOf,
  metaPath,
  secretPath,
  segment,
} from "./paths.js";

/**
 * The on-disk bookkeeping beside a credential's files. It carries NO secret: the secret is either
 * in `files/` or in `secret`, both 0600, and this is what a `CredentialSummary` is built from.
 */
interface CredentialMeta {
  /** The format's own version, so a future field is not read as if it were this one. */
  readonly v: 1;
  readonly method: "files" | "token" | "apiKey";
  readonly files: readonly string[];
  /** The env var a token / apiKey credential lands as, or null for the files shape. */
  readonly env: string | null;
  readonly fingerprint: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string | null;
}

/**
 * What the store needs from the rest of the daemon, and nothing more.
 *
 * A hook object rather than the `WorkerRegistry` interface, for `CatalogProbeHooks`'s reason: the
 * wiring is circular by nature — the registry asks the store to resolve a credential at create
 * time, and the store asks the registry which live workers are linked to a credential it is about
 * to overwrite. Naming only the two calls it makes keeps that a late binding rather than a
 * construction-order puzzle.
 */
export interface CredentialStoreHooks {
  /** Live workers of this token linked to `<agentId>/<name>`, with their reload requirement. */
  linked(
    tokenId: TokenId,
    agentId: string,
    name: string,
  ): readonly { readonly workerId: WorkerId; readonly reload: "file" | "restart" }[];
  /**
   * The DEEP check: spawn one throwaway process with this credential's home and send a minimal
   * prompt. Absent ⇒ `deep:true` is answered with the light check and `deep:false`, which is the
   * honest reading of "we could not do that here" (D29).
   */
  deepCheck?(o: {
    readonly agentId: string;
    readonly binding: CredentialBinding;
    readonly timeoutMs: number;
  }): Promise<LoginState>;
}

export interface CredentialStoreOptions {
  readonly dataDir: string;
  readonly config: ResolvedDaemonConfig;
  readonly catalog: Catalog;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hooks?: CredentialStoreHooks;
}

/** `list()` for an admin walks the whole tree; this is one token's row of it. */
interface Located {
  readonly tokenId: TokenId;
  readonly agentId: string;
  readonly name: string;
  readonly dir: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

/**
 * Is a credential WRITE admissible on this daemon's transport?
 *
 * A `PUT` is the one request body in the repository that carries a plaintext secret, so it is
 * refused unless the connection cannot be read off the wire: loopback, or TLS. TLS is M3's later
 * work package and there is nothing to test yet, so the test today is `listen.host` — which is
 * exactly what §凭据仓库 says to do, and `credentials.allowInsecureTransport` is the operator's
 * escape hatch for terminating TLS in front of the daemon.
 *
 * `listen: null` is IN-PROCESS ONLY (D15): there is no socket at all, so there is nothing to
 * intercept and the answer is yes.
 */
export function transportIsSecure(config: ResolvedDaemonConfig): boolean {
  if (config.credentials.allowInsecureTransport) return true;
  const listen = config.listen;
  if (listen === null) return true;
  return LOOPBACK.has(listen.host.trim().toLowerCase());
}

/**
 * The credential store (docs/M3-WP1-CREDENTIALS.md).
 *
 * THREE rules shape every method below, and each of them is structural rather than remembered:
 *
 *  1. **Ownership is the PATH.** `<dataDir>/credentials/<tokenId>/<agentId>/<name>/`, so a read
 *     for token `b` never constructs a path into token `a`'s tree. A cross-token reference is
 *     `403 credential_forbidden` and NEVER a 404, because a 404 would confirm the name exists.
 *  2. **Secrets only go up.** No method here returns one. `read` exists for the daemon's own
 *     composition step, is not on the HTTP surface, and is the only thing in the file that touches
 *     a secret value at all.
 *  3. **An admin may LIST every token's credentials and read none of their contents.** D13 gives
 *     an admin the whole machine's worker fleet; it does not give them other people's logins.
 */
export function createCredentialStore(o: CredentialStoreOptions): CredentialStore & {
  /** The daemon's own composition step. NOT on the HTTP surface: it returns a secret. */
  read(
    tokenId: TokenId,
    agentId: string,
    name: string,
  ): Promise<{
    readonly meta: CredentialMeta;
    readonly dir: string;
    readonly secret: string | null;
  }>;
  /** Resolve `CreateWorkerRequest.credential` into a binding, or refuse (`422`/`403`). */
  resolveFor(o: {
    readonly auth: AuthContext;
    readonly agentId: string;
    readonly requested: string | undefined;
    readonly home: string | null;
  }): Promise<CredentialBinding>;
  /** The descriptor's credential contract for this agent, or null. */
  contractFor(agentId: string): RuntimeCredentials | null;
} {
  const logger = o.logger.child({ mod: "credentials" });

  const contractFor = (agentId: string): RuntimeCredentials | null =>
    o.catalog.descriptor(agentId).credentials ?? null;

  const notFound = (agentId: string, name: string): never => {
    throw new OmniError(
      "credential_required",
      `no credential ${JSON.stringify(name)} is stored for agent ${JSON.stringify(agentId)} on this token`,
      { detail: { agentId, name } },
    );
  };

  const readMeta = async (dir: string): Promise<CredentialMeta | null> => {
    try {
      const parsed = JSON.parse(await readFile(metaPath(dir), "utf8")) as CredentialMeta;
      return parsed.v === 1 ? parsed : null;
    } catch {
      return null;
    }
  };

  const inUseBy = (tokenId: TokenId, agentId: string, name: string): number =>
    o.hooks?.linked(tokenId, agentId, name).length ?? 0;

  const summaryOf = (located: Located, meta: CredentialMeta): CredentialSummary => ({
    agentId: located.agentId,
    name: located.name,
    ownerTokenId: located.tokenId,
    method: meta.method,
    fingerprint: meta.fingerprint,
    files: [...meta.files].sort(),
    env: meta.env,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    expiresAt: meta.expiresAt,
    inUseBy: inUseBy(located.tokenId, located.agentId, located.name),
  });

  /**
   * Walk one token's tree. The DIRECTORY NAMES are what the store holds, and they may be
   * hex-encoded (`segment`), so the walk reads the agent id and the name back out of `meta.json`'s
   * own directory structure rather than trying to decode a path — which is why `list` builds a
   * `Located` from the traversal instead of from a string split.
   */
  const listToken = async (tokenId: TokenId): Promise<CredentialSummary[]> => {
    const root = join(credentialsRoot(o.dataDir), segment(tokenId));
    const out: CredentialSummary[] = [];
    let agents: string[];
    try {
      agents = (await readdir(root, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return out;
    }
    for (const agentSeg of agents) {
      let names: string[];
      try {
        names = (await readdir(join(root, agentSeg), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const nameSeg of names) {
        const dir = join(root, agentSeg, nameSeg);
        const meta = await readMeta(dir);
        if (meta === null) continue;
        out.push(
          summaryOf({ tokenId, agentId: decode(agentSeg), name: decode(nameSeg), dir }, meta),
        );
      }
    }
    return out;
  };

  const store: ReturnType<typeof createCredentialStore> = {
    contractFor,

    async list(auth): Promise<CredentialListResponse> {
      if (auth.role !== "admin") return { credentials: await listToken(auth.tokenId) };
      // D13: an admin sees the whole machine. The CONTENTS stay unreadable either way — this is a
      // list of SUMMARIES, and `read` is not on the HTTP surface at all (§凭据仓库: admin 可 list
      // 不可读内容).
      const out: CredentialSummary[] = [];
      let tokens: string[];
      try {
        tokens = (await readdir(credentialsRoot(o.dataDir), { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        return { credentials: out };
      }
      for (const tokenSeg of tokens) out.push(...(await listToken(decode(tokenSeg) as TokenId)));
      return { credentials: out };
    },

    async get(auth, agentId, name): Promise<CredentialSummary> {
      assertName(name);
      // The path is built from `auth.tokenId`, so this read CANNOT reach another token's tree —
      // which is why the 422 below leaks nothing: a caller learns that THEY have no such name,
      // and never whether anybody else does.
      const dir = credentialDir(o.dataDir, auth.tokenId, agentId, name);
      const meta = await readMeta(dir);
      if (meta === null) return notFound(agentId, name);
      return summaryOf({ tokenId: auth.tokenId, agentId, name, dir }, meta);
    },

    async put(auth, agentId, name, input): Promise<CredentialPutResult> {
      if (!transportIsSecure(o.config)) {
        throw new OmniError(
          "insecure_transport",
          "a credential may only be written over TLS or a loopback connection; " +
            "set credentials.allowInsecureTransport if TLS terminates in front of this daemon",
        );
      }
      // The ACL first, for `registry.create`'s reason: a token that may not use this agent learns
      // nothing about whether it exists on this machine, and it certainly may not store a
      // credential for it.
      auth.assertAgent(agentId);
      assertName(name);
      const contract = contractFor(agentId);

      const dir = credentialDir(o.dataDir, auth.tokenId, agentId, name);
      const previous = await readMeta(dir);
      const now = o.clock.iso();

      const written = await writeCredential({ dir, input, contract, agentId });
      const meta: CredentialMeta = {
        v: 1,
        method: written.method,
        files: written.files,
        env: written.env,
        fingerprint: written.fingerprint,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
        expiresAt: written.expiresAt,
      };
      await writeJson(metaPath(dir), meta);

      const linked = o.hooks?.linked(auth.tokenId, agentId, name) ?? [];
      const result: CredentialPutResult = {
        ...summaryOf({ tokenId: auth.tokenId, agentId, name, dir }, meta),
        // The number is read AFTER the write, because that is the question an operator is asking:
        // how many live workers are now reading the credential I just replaced.
        inUseBy: linked.length,
        workersAffected: linked.length,
        /**
         * The ones a swap does NOT reach on its own.
         *
         * Every live worker's home already LINKS to the file that just changed, so a
         * `reload:"file"` agent (claude-acp, measured) picks the new credential up on its next
         * request with nothing else happening. A `reload:"restart"` agent (codex-acp, measured)
         * cached it at startup and will keep using the old one until its process is replaced —
         * which is a fact the operator cannot possibly derive from a summary, and the whole reason
         * this field exists.
         */
        restartRequired: linked.filter((w) => w.reload === "restart").map((w) => w.workerId),
      };
      logger.info("stored a credential", {
        agentId,
        name,
        method: meta.method,
        fingerprint: meta.fingerprint,
        workersAffected: result.workersAffected,
        restartRequired: result.restartRequired.length,
      });
      return result;
    },

    async remove(auth, agentId, name): Promise<void> {
      auth.assertAgent(agentId);
      assertName(name);
      const dir = credentialDir(o.dataDir, auth.tokenId, agentId, name);
      const meta = await readMeta(dir);
      if (meta === null) return notFound(agentId, name);
      const used = o.hooks?.linked(auth.tokenId, agentId, name) ?? [];
      if (used.length > 0) {
        // 409, not a silent orphan: every one of those workers' homes links AT this file, and
        // removing it would leave them pointing at nothing — which on both real agents is an
        // authentication failure on the next request rather than an error anybody could trace.
        throw new OmniError(
          "worker_busy",
          `credential ${JSON.stringify(name)} is in use by ${String(used.length)} live worker(s); close or re-credential them first`,
          { detail: { workers: used.map((w) => w.workerId) } },
        );
      }
      await rm(dir, { recursive: true, force: true });
      logger.info("removed a credential", { agentId, name });
    },

    async check(auth, agentId, name, body): Promise<LoginState> {
      auth.assertAgent(agentId);
      assertName(name);
      const light = await lightCheck(auth.tokenId, agentId, name);
      if (body.deep !== true) return light;
      const deep = o.hooks?.deepCheck;
      if (deep === undefined) {
        // D29's honest answer: `deep` was asked for and could not be done, so the reply says
        // `deep: false` and carries the light verdict rather than dressing one up as the other.
        return { ...light, detail: "this daemon was built without a deep credential check" };
      }
      if (light.state === "required") return light;
      if (contractFor(agentId) === null) return light;
      const binding = await store.resolveFor({
        auth,
        agentId,
        requested: name,
        // A deep check gets a THROWAWAY home under the store's own tree, never a worker's: a
        // probe that wrote `projects/` into a live worker's home would be a probe with a side
        // effect on somebody's session (§17.4's `mkdtemp` rule, applied to the home).
        home: null,
      });
      try {
        return await deep({
          agentId,
          binding,
          timeoutMs: body.timeoutMs ?? o.config.probe.timeoutMs,
        });
      } catch (e) {
        return {
          state: "unknown",
          method: binding.method,
          credential: name,
          fingerprint: binding.fingerprint,
          checkedAt: o.clock.iso(),
          deep: true,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    },

    async loginFor(auth, agentId): Promise<LoginState> {
      // NEVER rejects (its contract): `GET /v1/agents` serves this for every configured agent,
      // including ones this token may not use, and a failure there would break the whole catalogue
      // over one row. "We could not tell" is `unknown`, which is a real answer.
      try {
        return await lightCheck(auth.tokenId, agentId, undefined);
      } catch {
        return { state: "unknown", checkedAt: o.clock.iso(), deep: false };
      }
    },

    async read(tokenId, agentId, name) {
      const dir = credentialDir(o.dataDir, tokenId, agentId, name);
      const meta = await readMeta(dir);
      if (meta === null) return notFound(agentId, name);
      const secret =
        meta.method === "files" ? null : await readFile(secretPath(dir), "utf8").catch(() => null);
      return { meta, dir, secret };
    },

    /**
     * `CreateWorkerRequest.credential` → a `CredentialBinding`, or a refusal.
     *
     * THE CREATE-TIME VALIDATION (§Home 隔离: 创建时校验 — 凭据缺失/过期 → 422, 不要等第一个
     * prompt). A worker whose credential is missing would otherwise handshake fine and fail on the
     * first prompt with `-32000 Authentication required` on claude, or fail at `session/new` on
     * codex — a 502 from the agent for something the daemon knew before it spawned anything.
     */
    async resolveFor(spec): Promise<CredentialBinding> {
      const contract = contractFor(spec.agentId);
      const requested = spec.requested;

      // A runtime with no credential contract has nothing to isolate: there is no home env var to
      // set and no file to link, so the only honest answer is the daemon's own environment. That
      // is M2 exactly, and it is why `credentials: null` in a descriptor means "inherit".
      if (contract === null) {
        if (requested !== undefined && requested !== INHERIT) {
          throw new OmniError(
            "bad_request",
            `agent ${JSON.stringify(spec.agentId)} declares no credential contract, so it can only run on the inherited environment`,
            { detail: { agentId: spec.agentId, requested } },
          );
        }
        return inheritBinding();
      }

      if (requested === NONE) {
        // An EMPTY home: the home env var is set, no credential file is linked, and the agent is
        // demonstrably unauthenticated. It is how an operator proves a worker is not quietly
        // borrowing the daemon's own login — and `create` refuses it with `422
        // credential_required` unless the caller really meant it (see the registry).
        return {
          name: null,
          method: "none",
          fingerprint: null,
          home: spec.home,
          env: spec.home === null ? {} : { [contract.homeEnv]: spec.home },
        };
      }

      if (requested === INHERIT) {
        if (!o.config.credentials.allowInherit) {
          throw new OmniError(
            "credential_required",
            "this daemon does not allow a worker to inherit its environment (credentials.allowInherit is false); name a stored credential",
          );
        }
        return inheritBinding();
      }

      const name = requested ?? DEFAULT_CREDENTIAL;
      const dir = credentialDir(o.dataDir, spec.auth.tokenId, spec.agentId, name);
      const meta = await readMeta(dir);

      if (meta === null) {
        // An OMITTED credential falls back to `inherit` (§Home 隔离), which is M2's behaviour and
        // what keeps every existing test passing unchanged. An EXPLICIT name that is not there is
        // a `422`, because the caller asked for something specific and did not get it.
        if (requested === undefined) {
          if (!o.config.credentials.allowInherit) {
            throw new OmniError(
              "credential_required",
              `no credential is stored for agent ${JSON.stringify(spec.agentId)} on this token, and this daemon does not allow inheriting its environment`,
              { detail: { agentId: spec.agentId } },
            );
          }
          return inheritBinding();
        }
        return notFound(spec.agentId, name);
      }

      if (meta.expiresAt !== null && Date.parse(meta.expiresAt) <= o.clock.now()) {
        // `credential_expired` rather than `credential_required`, because the fix is different: one
        // says "store a credential", the other says "store a NEWER one", and an operator reading
        // a 422 has to be able to tell those apart without opening the store.
        throw new OmniError(
          "credential_expired",
          `credential ${JSON.stringify(name)} for agent ${JSON.stringify(spec.agentId)} expired at ${meta.expiresAt}`,
          { detail: { agentId: spec.agentId, name, expiresAt: meta.expiresAt } },
        );
      }

      const env: Record<string, string> = {};
      if (spec.home !== null) env[contract.homeEnv] = spec.home;
      if (meta.method !== "files") {
        const variable = meta.env;
        const secret = await readFile(secretPath(dir), "utf8").catch(() => null);
        if (variable === null || secret === null) {
          throw new OmniError(
            "credential_required",
            `credential ${JSON.stringify(name)} is stored without the ${meta.method} value it needs`,
          );
        }
        env[variable] = secret;
      }

      return {
        name,
        method: meta.method,
        fingerprint: meta.fingerprint,
        home: spec.home,
        env,
      };
    },
  };

  /**
   * The LIGHT check (§探测: 轻检查 = 文件存在 + expiresAt).
   *
   * It deliberately does NOT handshake, and the measurement is why: on claude-acp `initialize`
   * answers `authMethods: []` and `session/new` SUCCEEDS whether or not there is a credential —
   * only `session/prompt` tells them apart — and on codex-acp the refusal lands at `session/new`.
   * So proving a login costs a process on one agent and a prompt on the other, which is what
   * `deep` is for. The file and its `expiresAt` are what can be known for free.
   */
  async function lightCheck(
    tokenId: TokenId,
    agentId: string,
    name: string | undefined,
  ): Promise<LoginState> {
    const checkedAt = o.clock.iso();
    const contract = contractFor(agentId);
    if (contract === null) {
      return {
        state: "unknown",
        method: INHERIT,
        credential: null,
        checkedAt,
        deep: false,
        detail: "this runtime declares no credential contract; a worker inherits the environment",
      };
    }
    const resolved = name ?? DEFAULT_CREDENTIAL;
    const dir = credentialDir(o.dataDir, tokenId, agentId, resolved);
    const meta = await readMeta(dir);
    if (meta === null) {
      return {
        state: o.config.credentials.allowInherit && name === undefined ? "unknown" : "required",
        method: o.config.credentials.allowInherit && name === undefined ? INHERIT : undefined,
        credential: name === undefined ? null : resolved,
        checkedAt,
        deep: false,
        detail:
          o.config.credentials.allowInherit && name === undefined
            ? "no credential is stored; a worker would inherit the daemon's environment"
            : `no credential ${JSON.stringify(resolved)} is stored for this agent`,
      };
    }
    const expired = meta.expiresAt !== null && Date.parse(meta.expiresAt) <= o.clock.now();
    return {
      state: expired ? "expired" : "ok",
      method: meta.method,
      credential: resolved,
      fingerprint: meta.fingerprint,
      expiresAt: meta.expiresAt,
      checkedAt,
      deep: false,
      ...(expired ? { detail: `the stored credential expired at ${String(meta.expiresAt)}` } : {}),
    };
  }

  function inheritBinding(): CredentialBinding {
    // M2's behaviour, named. `home: null` and an empty `env` mean `toSpawnSpec` composes exactly
    // what it composed before this work package existed.
    return { name: null, method: INHERIT, fingerprint: null, home: null, env: {} };
  }

  /**
   * Write the credential's files, 0600, under a directory at 0700, and return what `meta.json`
   * should say about them.
   *
   * `files` is written through a TEMP-AND-RENAME per file for the reason the home manager links
   * with one: a live worker's home points AT these files, so a partial write is a live agent
   * reading half a credential. An in-place `writeFile` would have exactly that window.
   */
  async function writeCredential(spec: {
    dir: string;
    input: CredentialInput;
    contract: RuntimeCredentials | null;
    agentId: string;
  }): Promise<{
    method: "files" | "token" | "apiKey";
    files: readonly string[];
    env: string | null;
    fingerprint: string;
    expiresAt: string | null;
  }> {
    await mkdir(spec.dir, { recursive: true, mode: DIR_MODE });
    await chmod(spec.dir, DIR_MODE).catch(() => {});

    if (spec.input.kind === "files") {
      const declared = new Set(spec.contract?.files ?? []);
      const names = Object.keys(spec.input.files);
      if (names.length === 0) {
        throw new OmniError("bad_request", "a files credential must carry at least one file");
      }
      for (const name of names) {
        // The descriptor's list is the allowlist, and this is the check that makes it one: an
        // agent that reads `.credentials.json` has no business being handed `id_rsa`, and a store
        // that accepted any name would be a general-purpose file drop with a 0600 mode.
        if (declared.size > 0 && !declared.has(name)) {
          throw new OmniError(
            "bad_request",
            `agent ${JSON.stringify(spec.agentId)} reads ${[...declared].map((f) => JSON.stringify(f)).join(", ")}; it does not read ${JSON.stringify(name)}`,
            { detail: { agentId: spec.agentId, file: name, declared: [...declared] } },
          );
        }
      }
      const dir = filesDir(spec.dir);
      await mkdir(dir, { recursive: true, mode: DIR_MODE });
      await chmod(dir, DIR_MODE).catch(() => {});
      // Remove files a previous version of this credential had and this one does not, so an
      // in-place update cannot leave a stale second credential file the agent might prefer.
      for (const stale of await readdir(dir).catch(() => [] as string[])) {
        if (!names.includes(stale)) await rm(join(dir, stale), { force: true }).catch(() => {});
      }
      let expiresAt: string | null = null;
      for (const [name, content] of Object.entries(spec.input.files)) {
        await writeSecretFile(join(dir, segment(name)), content);
        if (expiresAt === null) {
          try {
            expiresAt = expiresAtOf(JSON.parse(content));
          } catch {
            // A credential that is not JSON is perfectly legal and simply carries no expiry.
          }
        }
      }
      return {
        method: "files",
        files: names,
        env: null,
        fingerprint: fingerprintOf(Object.entries(spec.input.files)),
        expiresAt,
      };
    }

    const input = spec.input;
    const isToken = input.kind === "token";
    const value = input.kind === "token" ? input.token : input.apiKey;
    const variable = isToken ? spec.contract?.tokenEnv : spec.contract?.apiKeyEnv;
    if (variable === undefined) {
      throw new OmniError(
        "bad_request",
        `agent ${JSON.stringify(spec.agentId)} declares no environment variable for a ${input.kind} credential`,
        { detail: { agentId: spec.agentId, kind: input.kind } },
      );
    }
    await rm(filesDir(spec.dir), { recursive: true, force: true }).catch(() => {});
    await writeSecretFile(secretPath(spec.dir), value);
    return {
      method: isToken ? "token" : "apiKey",
      files: [],
      env: variable,
      fingerprint: fingerprintOf([[variable, value]]),
      expiresAt: null,
    };
  }

  async function writeSecretFile(at: string, content: string): Promise<void> {
    const temp = `${at}.omni-${String(process.pid)}-${Date.now().toString(36)}`;
    await writeFile(temp, content, { mode: FILE_MODE });
    // `writeFile`'s mode is umask-masked, and on a pre-existing file it is not applied at all —
    // so the `chmod` is the half that actually bites. It is the same posture `probe-cache.ts`
    // takes, and on Windows it is advisory, which is a platform fact rather than a silent failure.
    await chmod(temp, FILE_MODE).catch(() => {});
    await rename(temp, at);
  }

  async function writeJson(at: string, body: unknown): Promise<void> {
    await writeSecretFile(at, `${JSON.stringify(body, null, 2)}\n`);
  }

  return store;
}

/** `segment()`'s inverse, for the directory walk. A plain name decodes to itself. */
function decode(raw: string): string {
  if (!raw.startsWith("x-")) return raw;
  try {
    return Buffer.from(raw.slice(2), "hex").toString("utf8");
  } catch {
    return raw;
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The credential NAME, checked HERE as well as in zod.
 *
 * Two places on purpose, and it is the one duplication in this work package that is deliberate:
 * `CreateWorkerRequest.credential` and `SetCredentialBody.credential` narrow it on the wire, and
 * `WorkerRegistry.create` is also D15's IN-PROCESS entry point with no schema in front of it. A
 * name is a path segment; a path segment an embedder can choose freely is the bug that matters.
 */
export function assertName(name: string): void {
  if (!NAME.test(name) || name === "." || name === "..") {
    throw new OmniError(
      "bad_request",
      `a credential name is up to 64 characters of [A-Za-z0-9._-], got ${JSON.stringify(name.slice(0, 32))}`,
    );
  }
}

/** Exported for the store's own tests: the agent's directory, so a test can plant a tree. */
export { agentRoot };

/**
 * `403 credential_forbidden`'s one producer (§凭据仓库: 跨 token 引用 → 403).
 *
 * It lives beside the store rather than inside it because the store CANNOT reach another token's
 * tree — the path is built from `auth.tokenId` — so the cross-token case is not a store read at
 * all: it is a WORKER REQUEST naming something outside its own namespace, and `registry.create`
 * is where that is detected. The message names the name the caller typed and says nothing about
 * whether it exists.
 */
export function credentialForbidden(name: string): OmniError {
  return new OmniError(
    "credential_forbidden",
    `credential ${JSON.stringify(name)} is not available to this token`,
  );
}
