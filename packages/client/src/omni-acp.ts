import { OmniError, type ClientId, type CredentialInput } from "@omni-acp/protocol";
import { connectServer, type Server } from "./server.js";
import { local, type LocalOptions } from "./local.js";
import { localCredential, type LocalCredentialOptions } from "./local-credential.js";

export interface ConnectOptions {
  readonly url: string;
  readonly token: string;
  /**
   * → `Omni-Client-Id`; default: a fresh ULID per `connect()`, minted by `transport.ts`.
   *
   * M0 minted one per PROCESS, on the reasoning that two connections from one script should not
   * look like two clients. M1's lease inverts that: §16.1 rule L4 makes the client id the unit of
   * CONTROL, and the acceptance script's whole step 4 is two `connect()` calls on one token
   * discovering that the second is refused with a `423` naming the first. A process-wide id
   * would make that scenario unreachable, so the default moved (CONTRACTS.md §5.7).
   */
  readonly clientId?: ClientId;
  /** Injectable. Tests pass `daemon.fetch` and touch no socket at all. */
  readonly fetch?: typeof globalThis.fetch;
  /** Default 30_000; SSE excluded. */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * `globalThis.fetch` reached through a wrapper rather than passed by reference.
 *
 * Undici tolerates an unbound `fetch`, but a bare reference also freezes whatever `fetch` was
 * installed at module-load time — which breaks every test double that replaces `globalThis.fetch`
 * afterwards, and the fix is invisible when it goes wrong.
 */
const globalFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);

/**
 * `connect()` issues exactly ONE request, `GET /v1/whoami`, and exposes the answer as
 * `server.me` (DESIGN §8). A client that has to probe several endpoints to learn what it may do
 * is a client whose permissions can drift between probes.
 */
export const OmniACP: {
  connect(opts: ConnectOptions): Promise<Server>;
  local(opts?: LocalOptions): Promise<Server>;
  /**
   * M3-WP1. This machine's own login for `agent`, as a `CredentialInput` ready for
   * `server.credentials.put()`.
   *
   * It is on the CLIENT and not on the daemon deliberately: a daemon that read
   * `~/.claude/.credentials.json` on request would be a daemon that reads any file you can name.
   * See `local-credential.ts` for the paths and the evidence behind them.
   */
  localCredential(agent: string, opts?: LocalCredentialOptions): Promise<CredentialInput>;
} = {
  // `async` on purpose: a validation failure must arrive as a REJECTION, not as a synchronous
  // throw out of a function whose return type is a promise. The caller writes one `catch`.
  async connect(opts: ConnectOptions): Promise<Server> {
    if (typeof opts.url !== "string" || opts.url.trim() === "") {
      throw new OmniError("bad_request", "connect() needs a url");
    }
    if (typeof opts.token !== "string" || opts.token === "") {
      throw new OmniError("bad_request", "connect() needs a token");
    }
    return connectServer({
      url: opts.url,
      token: opts.token,
      // Absent ⇒ `createTransport` mints one. Passing `undefined` through rather than choosing a
      // default here keeps the id's provenance in ONE file (§5.7).
      ...(opts.clientId === undefined ? {} : { clientId: opts.clientId }),
      fetch: opts.fetch ?? globalFetch,
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  },
  local(opts?: LocalOptions): Promise<Server> {
    return local(opts);
  },
  localCredential(agent: string, opts?: LocalCredentialOptions): Promise<CredentialInput> {
    return localCredential(agent, opts);
  },
};
