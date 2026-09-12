import {
  OmniError,
  type AuthContext,
  type CredentialBinding,
  type HomeManager,
  type Logger,
  type ResolvedDaemonConfig,
  type RuntimeCredentials,
  type WorkerId,
} from "@omni-acp/protocol";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_CREDENTIAL,
  INHERIT,
  NONE,
  credentialDir,
  credentialsRoot,
  filesDir,
  metaPath,
  segment,
} from "./paths.js";
import { assertName, credentialForbidden, type createCredentialStore } from "./store.js";

/**
 * The one object `registry.ts` talks to about credentials.
 *
 * It exists so the registry never joins a path or names a mode: "which credential does this
 * request resolve to, and what does the worker's home have to look like for it" is ONE question
 * with ONE answer, and splitting it across the store (content), the home manager (directories)
 * and the registry (which worker) is how the create path and the wake path come to build two
 * different environments for one worker.
 *
 * Every method takes an `AuthContext`, because ownership is the token (§凭据仓库).
 */
export interface CredentialLayer {
  /** The descriptor's credential contract for this agent, or null ⇒ inherit (M2). */
  contractFor(agentId: string): RuntimeCredentials | null;
  /**
   * CREATE-TIME VALIDATION, before a slot is reserved and before anything spawns.
   *
   * It reads the store and nothing else — no home, no links — so a `422 credential_required`
   * costs neither a `maxWorkers` slot nor a ~7 s `npx` cold start. §Home 隔离's "创建时校验 …
   * 不要等第一个 prompt" is this method.
   */
  validate(o: {
    readonly auth: AuthContext;
    readonly agentId: string;
    readonly requested: string | undefined;
  }): Promise<void>;
  /**
   * Resolve the credential AND make this worker's home match it: create `<dataDir>/homes/<wid>`,
   * link (or unlink) every file the descriptor declares, and return what the worker should report
   * and spawn with.
   *
   * Idempotent per worker, which is what makes it callable on create, on a rehydrate and on a
   * `setCredential` alike — E7 requires the SAME directory every time, so `create` on an existing
   * home is a no-op and `link` is a `rename` over whatever was there.
   */
  bind(o: {
    readonly auth: AuthContext;
    readonly agentId: string;
    readonly requested: string | undefined;
    readonly workerId: WorkerId;
    readonly home: "isolated" | "shared";
  }): Promise<CredentialBinding>;
  /** Drop a worker's home. Called after `close` + retention, never at close (E7). */
  releaseHome(workerId: WorkerId): Promise<void>;
  readonly homes: HomeManager;
}

export interface CredentialLayerOptions {
  readonly dataDir: string;
  readonly config: ResolvedDaemonConfig;
  readonly store: ReturnType<typeof createCredentialStore>;
  readonly homes: HomeManager;
  readonly logger: Logger;
}

export function createCredentialLayer(o: CredentialLayerOptions): CredentialLayer {
  const logger = o.logger.child({ mod: "credentials" });

  /**
   * `403 credential_forbidden` for a cross-token reference (§凭据仓库, acceptance 6).
   *
   * THE TRADE-OFF IS DELIBERATE AND IT IS THE SPEC'S. A credential name lives inside its token's
   * namespace — `CreateWorkerRequest.credential` has no syntax for "somebody else's" — so a name
   * this token has not stored is naturally a `422 credential_required`, and answering `403` for
   * exactly the names ANOTHER token happens to own reveals that those names exist somewhere.
   *
   * The spec asks for the `403` anyway, and it is the right call: the whole point of the code is
   * to tell an operator "that credential is not yours" rather than "that credential does not
   * exist", which is a materially different thing to debug when two people share a machine. What
   * leaks is one bit about a NAME — never its agent binding beyond the one asked about, never its
   * content, never its owner — and `403 credential_forbidden`'s message says nothing more.
   */
  const existsElsewhere = async (
    auth: AuthContext,
    agentId: string,
    name: string,
  ): Promise<boolean> => {
    let tokens: string[];
    try {
      tokens = (await readdir(credentialsRoot(o.dataDir), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return false;
    }
    const mine = segment(auth.tokenId);
    for (const tokenSeg of tokens) {
      if (tokenSeg === mine) continue;
      const dir = join(credentialsRoot(o.dataDir), tokenSeg, segment(agentId), segment(name));
      try {
        // `meta.json` and not the directory: a directory with no meta is a half-written
        // credential, which is nothing to tell anybody about.
        await stat(metaPath(dir));
        return true;
      } catch {
        continue;
      }
    }
    return false;
  };

  const resolve = async (spec: {
    auth: AuthContext;
    agentId: string;
    requested: string | undefined;
    home: string | null;
  }): Promise<CredentialBinding> => {
    if (spec.requested !== undefined && spec.requested !== INHERIT && spec.requested !== NONE) {
      assertName(spec.requested);
    }
    try {
      return await o.store.resolveFor(spec);
    } catch (e) {
      // A `422` for a name that is really somebody ELSE's becomes the `403` the spec asks for.
      // Only for an EXPLICIT name: an omitted credential falls back to `inherit` and never
      // reaches this branch, so nobody discovers a name by not naming one.
      if (
        OmniError.is(e, "credential_required") &&
        spec.requested !== undefined &&
        spec.requested !== INHERIT &&
        spec.requested !== NONE &&
        (await existsElsewhere(spec.auth, spec.agentId, spec.requested))
      ) {
        throw credentialForbidden(spec.requested);
      }
      throw e;
    }
  };

  return {
    contractFor: (agentId) => o.store.contractFor(agentId),
    homes: o.homes,

    async validate(spec): Promise<void> {
      await resolve({ ...spec, home: null });
    },

    async bind(spec): Promise<CredentialBinding> {
      const contract = o.store.contractFor(spec.agentId);
      // A runtime with no credential contract has no home env var to set and no file to link, so
      // there is nothing to isolate and the answer is M2's inherited environment. `home:
      // "isolated"` on such an agent is not an error — it is a request for isolation the RUNTIME
      // cannot express, and building a directory nothing reads would be theatre.
      if (contract === null) return await resolve({ ...spec, home: null });

      const isolated = spec.home !== "shared";
      const home = isolated ? await o.homes.create(spec.workerId) : null;
      const binding = await resolve({ ...spec, home });

      if (home !== null) {
        if (binding.method === "files" && binding.name !== null) {
          const source = filesDir(
            credentialDir(o.dataDir, spec.auth.tokenId, spec.agentId, binding.name),
          );
          const linked = await o.homes.link({ home, files: contract.files, sourceDir: source });
          logger.debug("linked a credential into a worker home", {
            workerId: spec.workerId,
            mode: linked.mode,
            files: linked.files.length,
          });
        } else {
          // `none`, `inherit`-with-a-home, and the token / apiKey shapes all want an EMPTY home:
          // there is no file to link, and a file left over from a previous credential would be
          // the one the agent prefers. `unlink` touches only the descriptor's own file names, so
          // the agent's session state (E7) survives.
          await o.homes.unlink({ home, files: contract.files });
        }
      }
      return binding;
    },

    async releaseHome(workerId): Promise<void> {
      await o.homes.remove(workerId);
    },
  };
}
