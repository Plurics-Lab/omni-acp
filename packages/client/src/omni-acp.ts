import { OmniError, type ClientId } from "@omni-acp/protocol";
import type { Server } from "./server.js";
import type { LocalOptions } from "./local.js";

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

/**
 * `connect()` issues exactly ONE request, `GET /v1/whoami`, and exposes the answer as
 * `server.me` (DESIGN §8). A client that has to probe several endpoints to learn what it may do
 * is a client whose permissions can drift between probes.
 */
export const OmniACP: {
  connect(opts: ConnectOptions): Promise<Server>;
  local(opts?: LocalOptions): Promise<Server>;
} = {
  connect(_opts: ConnectOptions): Promise<Server> {
    throw new OmniError("internal", "unimplemented: WP-6 (client.OmniACP.connect)");
  },
  local(_opts?: LocalOptions): Promise<Server> {
    throw new OmniError("internal", "unimplemented: WP-6 (client.OmniACP.local)");
  },
};
