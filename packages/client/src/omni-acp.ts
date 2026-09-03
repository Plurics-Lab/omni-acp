import { OmniError, type ClientId } from "@omni-acp/protocol";
import { connectServer, type Server } from "./server.js";
import { local, type LocalOptions } from "./local.js";

export interface ConnectOptions {
  readonly url: string;
  readonly token: string;
  /** -> Omni-Client-Id; default: random per process. */
  readonly clientId?: ClientId;
  /** Injectable. Tests pass `daemon.fetch` and touch no socket at all. */
  readonly fetch?: typeof globalThis.fetch;
  /** Default 30_000; SSE excluded. */
  readonly requestTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Random per PROCESS, not per connection: `Omni-Client-Id` is recorded for audit and future
 * lease attribution (D13, CONTRACTS.md §2.1), and a value that changed per `connect()` would
 * make two connections from the same script look like two clients.
 */
const PROCESS_CLIENT_ID: ClientId = `c_${globalThis.crypto.randomUUID()}`;

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
      clientId: opts.clientId ?? PROCESS_CLIENT_ID,
      fetch: opts.fetch ?? globalFetch,
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
  },
  local(opts?: LocalOptions): Promise<Server> {
    return local(opts);
  },
};
