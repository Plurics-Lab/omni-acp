import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OmniError,
  type Clock,
  type CredentialBinding,
  type LoginState,
  type Logger,
  type ResolvedDaemonConfig,
  type RuntimeCredentials,
  type Supervisor,
} from "@omni-acp/protocol";
import { openAcpLink } from "@omni-acp/core";
import type { Catalog } from "../types.js";

/**
 * `POST /v1/credentials/{agent}/{name}/check {deep:true}` — the check that actually asks the
 * agent (§探测: `deep:true` 才发最小 prompt).
 *
 * It exists because the LIGHT check cannot answer the question, and the measurements are why:
 *
 *  - claude-acp 0.73.0 answers `initialize.authMethods: []` and `session/new` SUCCEEDS whether or
 *    not a credential is present. Only `session/prompt` distinguishes them, with
 *    `-32000 Authentication required`.
 *  - codex-acp 1.8.0 answers `authMethods: [api-key]` while FULLY LOGGED IN, so the array says
 *    nothing; its refusal lands at `session/new` (`-32000` with no file, `-32603 "plan type is
 *    required for chatgpt authentication"` with a malformed one).
 *
 * So the descriptor's `loginRequiredSignal` decides how far this has to go: `"session_new"` stops
 * at `session/new` and costs ZERO tokens, and `"prompt_-32000"` sends one minimal prompt.
 *
 * Four operability rules, each of them §17.4's and each of them load-bearing:
 *
 *  1. ONE throwaway process, through `Supervisor.spawn` and `Catalog.toSpawnSpec` — never a second
 *     spawn entry point (F10), which is what `no-direct-spawn` asserts.
 *  2. The cwd is a `mkdtemp`, removed afterwards, so a check cannot mutate a workspace.
 *  3. The HOME is the credential's own throwaway binding and never a live worker's, so a check
 *     cannot write `projects/` into somebody's session directory.
 *  4. The tree is reclaimed on EVERY edge, including the timeout (H5's rule).
 */
export interface DeepCheckOptions {
  readonly config: ResolvedDaemonConfig;
  readonly catalog: Catalog;
  readonly supervisor: Supervisor;
  readonly clock: Clock;
  readonly logger: Logger;
}

export function createDeepCheck(
  o: DeepCheckOptions,
): (spec: {
  readonly agentId: string;
  readonly binding: CredentialBinding;
  readonly timeoutMs: number;
}) => Promise<LoginState> {
  const logger = o.logger.child({ mod: "credentials", check: "deep" });

  return async function deepCheck(spec): Promise<LoginState> {
    const contract = o.catalog.descriptor(spec.agentId).credentials ?? null;
    const base = {
      method: spec.binding.method,
      credential: spec.binding.name,
      fingerprint: spec.binding.fingerprint,
      checkedAt: o.clock.iso(),
      deep: true,
    } satisfies Omit<LoginState, "state">;

    if (contract === null) {
      return { ...base, state: "unknown", detail: "this runtime declares no credential contract" };
    }

    const descriptor = o.catalog.get(spec.agentId);
    const cwd = await mkdtemp(join(tmpdir(), "omni-credcheck-"));
    const spawnSpec = o.catalog.toSpawnSpec(descriptor, {
      cwd,
      home: spec.binding.home,
      credentialEnv: spec.binding.env,
    });

    const proc = await o.supervisor.spawn(spawnSpec);
    /**
     * Every handler is supplied, and each one is the SAFE answer rather than a real one.
     *
     * An update during a check is noise we are not paid to interpret; a permission request is
     * REFUSED (§17.4's rule: the battery never sends a permission answer and never
     * `allow_always`) — and a check that answered one could let a "minimal prompt" write a file.
     */
    const link = openAcpLink(
      proc.stream,
      {
        onSessionUpdate: () => {},
        onPermissionRequest: () =>
          Promise.reject(new OmniError("forbidden", "a credential check answers no permission")),
        onClosed: () => {},
      },
      { logger },
    );
    // ONE budget for the whole check, on the injected clock, so a hung agent cannot hold a route
    // open (§17.4 rule 3). It is raced rather than passed down, because `AcpLink.request` takes no
    // signal — the same shape `probe.ts` uses.
    let expiry: { cancel(): void } | null = null;
    const budget = new Promise<never>((_resolve, reject) => {
      expiry = o.clock.setTimer(spec.timeoutMs, () => {
        reject(
          new OmniError(
            "agent_timeout",
            `the credential check timed out after ${String(spec.timeoutMs)}ms`,
          ),
        );
      });
    });
    budget.catch(() => {});
    const race = <T>(work: Promise<T>): Promise<T> => Promise.race([work, budget]);

    try {
      const init = await race(
        link.request<{ authMethods?: unknown[] }>("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
        }),
      );
      const methods = methodNamesOf(init?.authMethods);

      let session: { sessionId?: string } | null = null;
      try {
        session = await race(
          link.request<{ sessionId?: string }>("session/new", { cwd, mcpServers: [] }),
        );
      } catch (e) {
        // codex-acp's row. `-32000` is an explicit refusal; anything else with a code is a real
        // failure of the handshake and is reported as `unknown` rather than as "not logged in",
        // because asserting a cause we did not observe is the one thing the corpus rule forbids.
        const detail = messageOf(e);
        return {
          ...base,
          state: authenticationRefused(e) ? "required" : "unknown",
          ...(methods.length === 0 ? {} : { methods }),
          detail: `session/new refused: ${detail}`,
        };
      }

      const sessionId = session?.sessionId;
      if (typeof sessionId !== "string") {
        return { ...base, state: "unknown", detail: "session/new returned no session id" };
      }

      if (contract.loginRequiredSignal === "session_new") {
        // `session/new` is this runtime's gate and it just passed, so we are done — and we are
        // done WITHOUT spending a single token, which is why the signal is a descriptor field
        // rather than a constant.
        return { ...base, state: "ok", ...(methods.length === 0 ? {} : { methods }) };
      }

      try {
        await race(
          link.request("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "Reply with the single word OK." }],
          }),
        );
        return { ...base, state: "ok", ...(methods.length === 0 ? {} : { methods }) };
      } catch (e) {
        return {
          ...base,
          state: authenticationRefused(e) ? "required" : "unknown",
          ...(methods.length === 0 ? {} : { methods }),
          detail: `session/prompt refused: ${messageOf(e)}`,
        };
      }
    } finally {
      // Rule 4: the tree goes on EVERY edge, including a rejected `initialize` and a timeout. A
      // check that leaked an `npx` tree would be worse than no check.
      (expiry as { cancel(): void } | null)?.cancel();
      link.close();
      await proc.terminate({ force: true }).catch(() => {});
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  };
}

/**
 * `-32000 Authentication required` and nothing else.
 *
 * It is matched on the CODE, not on the message, for §17.3's reason — a message is not a stable
 * contract — and the code is the same on both real agents, which is the one thing about this that
 * generalises (claude on `session/prompt`, codex on `session/new`).
 */
function authenticationRefused(e: unknown): boolean {
  if (e instanceof OmniError) return e.acp?.code === -32000;
  const code = (e as { code?: unknown } | null)?.code;
  return code === -32000;
}

function messageOf(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string") return m.slice(0, 300);
  }
  return String(e).slice(0, 300);
}

/**
 * `initialize.authMethods` reduced to ids, for the RECORD and never for a verdict.
 *
 * Measured: codex-acp answers `[{id:"api-key", …}]` while logged in, so this list cannot decide
 * anything — it is reported because an operator debugging a `required` wants to know what the
 * agent said it would accept.
 */
function methodNamesOf(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") out.push(entry);
    else if (typeof entry === "object" && entry !== null) {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === "string") out.push(id);
    }
  }
  return out;
}

/** The descriptor's contract, re-exported for the store's type. */
export type { RuntimeCredentials };
