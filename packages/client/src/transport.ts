import { OmniError, type ClientId } from "@omni-acp/protocol";

export interface TransportOptions {
  readonly url: string;
  readonly token: string;
  readonly clientId: ClientId;
  /** Injectable. Tests pass `daemon.fetch` and touch no socket at all. */
  readonly fetch: typeof globalThis.fetch;
  readonly requestTimeoutMs: number;
}

export interface Transport {
  /** JSON in, JSON out, error bodies mapped back to `OmniError` with the code intact. */
  request<R = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<R>;
  /** SSE: no request timeout applies, and the caller owns the AbortSignal. */
  open(path: string, opts?: { signal?: AbortSignal }): Promise<Response>;
}

/**
 * The bearer token travels in the `Authorization` header and NEVER in a URL — not even for SSE,
 * where a query parameter would be the convenient thing and would end up in every proxy log
 * (CONTRACTS.md §8.4).
 */
export function createTransport(o: TransportOptions): Transport {
  throw new OmniError("internal", "unimplemented: WP-6 (client.createTransport)");
}
