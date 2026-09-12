import {
  OmniError,
  type CredentialCheckBody,
  type CredentialInput,
  type CredentialListResponse,
  type CredentialPutResult,
  type CredentialSummary,
  type LoginState,
} from "@omni-acp/protocol";
import type { Transport } from "./transport.js";

/**
 * `server.credentials` — M3-WP1's five calls (docs/M3-WP1-CREDENTIALS.md §线上协议).
 *
 * SECRETS ONLY GO UP, and this is the file where that is visible: `put` takes a
 * `CredentialInput`, and nothing here RETURNS one. `get` and `list` answer `CredentialSummary`,
 * whose strongest identifier is a 12-hex-character fingerprint — enough to tell two credentials
 * apart and useless for authenticating anything.
 *
 * `OmniACP.localCredential(agent)` is the companion that reads this machine's own login (see
 * `local-credential.ts`), and it lives on the CLIENT side for one reason: a daemon that read
 * `~/.claude/.credentials.json` for you would be a daemon that reads any file you can name.
 */
export interface CredentialsChannel {
  list(): Promise<readonly CredentialSummary[]>;
  /** `422 credential_required` for a name this token has not stored. */
  get(agentId: string, name?: string): Promise<CredentialSummary>;
  /**
   * Create, or UPDATE IN PLACE.
   *
   * A repeat `put` on a live name rewrites the canonical file every worker's home already links
   * to, which is why the result carries `workersAffected` and `restartRequired`: a
   * `reload:"file"` agent picks the new credential up on its next request (claude-acp, measured)
   * and a `reload:"restart"` one does not (codex-acp, measured). `restartRequired` names the
   * second group.
   *
   * `403 insecure_transport` when the connection is neither TLS nor loopback: this is the one
   * request body in the repository that carries a plaintext secret.
   */
  put(agentId: string, input: CredentialInput, name?: string): Promise<CredentialPutResult>;
  /** `409 worker_busy` while a live worker's home links to it. */
  remove(agentId: string, name?: string): Promise<void>;
  /**
   * The light check by default — the credential file is present and unexpired.
   *
   * `deep: true` spawns ONE throwaway process and, on an agent whose refusal only lands on
   * `session/prompt` (claude-acp, measured), sends one minimal prompt. It costs tokens, which is
   * why it is opt-in; on an agent whose refusal lands at `session/new` (codex-acp, measured) the
   * descriptor says so and the check stops there, for free.
   */
  check(agentId: string, name?: string, o?: CredentialCheckBody): Promise<LoginState>;
}

/**
 * The client deadline for a DEEP check.
 *
 * It spawns a process and may send a prompt, which is the probe's shape and therefore the probe's
 * budget: `ConnectOptions.requestTimeoutMs` defaults to 30 s and an `npx` cold start alone is ~7 s
 * on claude-acp and was once >90 s on codex-acp (its README's own measurement). A client that gave
 * up first would report `agent_timeout` for a check that worked.
 */
const DEEP_CHECK_TIMEOUT_MS = 180_000;

/** `default` is the name `createAgent({credential})` falls back to, so it is the default here. */
const DEFAULT_NAME = "default";

export function createCredentialsChannel(transport: Transport): CredentialsChannel {
  // The two path segments are encoded rather than trusted: an agent id is whatever an operator
  // configured, and a name with a `/` in it would otherwise address a different route entirely.
  // The SHAPE is the daemon's rule (one place, `assertName`); this only makes the URL honest.
  const path = (agentId: string, name: string): string =>
    `/v1/credentials/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`;

  const assertAgent = (agentId: string): void => {
    if (agentId === "") throw new OmniError("bad_request", "a credential call needs an agent id");
  };

  return {
    async list(): Promise<readonly CredentialSummary[]> {
      const body = await transport.request<CredentialListResponse>("GET", "/v1/credentials");
      return body.credentials;
    },

    async get(agentId, name = DEFAULT_NAME): Promise<CredentialSummary> {
      assertAgent(agentId);
      return await transport.request<CredentialSummary>("GET", path(agentId, name));
    },

    async put(agentId, input, name = DEFAULT_NAME): Promise<CredentialPutResult> {
      assertAgent(agentId);
      return await transport.request<CredentialPutResult>("PUT", path(agentId, name), input);
    },

    async remove(agentId, name = DEFAULT_NAME): Promise<void> {
      assertAgent(agentId);
      await transport.request("DELETE", path(agentId, name));
    },

    async check(agentId, name = DEFAULT_NAME, o?: CredentialCheckBody): Promise<LoginState> {
      assertAgent(agentId);
      return await transport.request<LoginState>(
        "POST",
        `${path(agentId, name)}/check`,
        o ?? {},
        o?.deep === true ? { timeoutMs: DEEP_CHECK_TIMEOUT_MS } : undefined,
      );
    },
  };
}
