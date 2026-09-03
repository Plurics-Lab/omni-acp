import {
  HEADER,
  OMNI_ERROR_CODES,
  OmniError,
  type ClientId,
  type OmniErrorCode,
} from "@omni-acp/protocol";

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
 * The status → code fallback, used ONLY when the daemon's body is not a well-formed
 * `OmniErrorBody` (a proxy 502, a truncated response, a non-omni server on the other end).
 *
 * It is deliberately not derived by inverting `ERROR_STATUS`: that map is many-to-one
 * (`forbidden` and `policy_exceeds_ceiling` both mean 403), so an inversion would have to pick a
 * winner anyway — and picking it here, once, in the open, beats picking it implicitly by
 * iteration order.
 */
const STATUS_CODE: { readonly [status: number]: OmniErrorCode } = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "worker_not_found",
  409: "worker_busy",
  410: "worker_closed",
  422: "not_resumable",
  423: "lease_held",
  429: "worker_limit",
  502: "agent_error",
  504: "agent_timeout",
};

const OMNI_CODES = new Set<string>(OMNI_ERROR_CODES);

function isOmniCode(v: unknown): v is OmniErrorCode {
  return typeof v === "string" && OMNI_CODES.has(v);
}

/**
 * Joins a base URL with an absolute `/v1/...` path by concatenation rather than `new URL(path,
 * base)`. `new URL("/v1/whoami", "http://h/omni")` silently discards the `/omni` prefix, which
 * is how an SDK that works against `http://127.0.0.1:7777` breaks the moment someone puts the
 * daemon behind a path-prefixing reverse proxy.
 */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The wire body of an error response, when the far end produced one. */
function errorFromBody(status: number, text: string): OmniError {
  const fallback = STATUS_CODE[status] ?? "internal";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON at all — a proxy error page, most likely. The status is still information.
    return new OmniError(
      fallback,
      text.trim() === "" ? `HTTP ${String(status)}` : text.slice(0, 512),
      {
        detail: { status },
      },
    );
  }

  const body =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const code = isOmniCode(body["code"]) ? body["code"] : fallback;
  const message = typeof body["message"] === "string" ? body["message"] : `HTTP ${String(status)}`;

  // `acp` is the agent's JSON-RPC error and is passed back through VERBATIM — never reshaped
  // (CONTRACTS.md §9). It is only read for shape, never rebuilt field by field.
  const acp = body["acp"];
  const hasAcp =
    typeof acp === "object" &&
    acp !== null &&
    typeof (acp as { code?: unknown }).code === "number" &&
    typeof (acp as { message?: unknown }).message === "string";

  return new OmniError(code, message, {
    ...(hasAcp ? { acp: acp as { code: number; message: string; data?: unknown } } : {}),
    detail: { status },
  });
}

/**
 * The bearer token travels in the `Authorization` header and NEVER in a URL — not even for SSE,
 * where a query parameter would be the convenient thing and would end up in every proxy log
 * (CONTRACTS.md §8.4).
 */
export function createTransport(o: TransportOptions): Transport {
  if (o.url.trim() === "") throw new OmniError("bad_request", "connect() needs a url");
  if (o.token === "") throw new OmniError("bad_request", "connect() needs a token");

  const headers = (extra?: Record<string, string>): Headers =>
    new Headers({
      [HEADER.auth]: `Bearer ${o.token}`,
      [HEADER.clientId]: o.clientId,
      ...extra,
    });

  /**
   * One send, one place where an abort is classified.
   *
   * A CALLER's abort is re-thrown as its own reason — an `AbortSignal` consumer expects the
   * reason it supplied, not a translation. Only OUR deadline becomes `agent_timeout`.
   */
  const send = async (
    request: Request,
    caller: AbortSignal | undefined,
    timedOut: () => boolean,
    describe: string,
  ): Promise<Response> => {
    try {
      return await o.fetch(request);
    } catch (e) {
      if (caller?.aborted === true) throw caller.reason;
      if (timedOut()) {
        throw new OmniError(
          "agent_timeout",
          `${describe} timed out after ${String(o.requestTimeoutMs)}ms`,
          {
            cause: e,
          },
        );
      }
      throw OmniError.from(e, "internal");
    }
  };

  return {
    async request<R = unknown>(
      method: string,
      path: string,
      body?: unknown,
      opts?: { signal?: AbortSignal },
    ): Promise<R> {
      opts?.signal?.throwIfAborted();

      const deadline = AbortSignal.timeout(o.requestTimeoutMs);
      const signal =
        opts?.signal === undefined ? deadline : AbortSignal.any([deadline, opts.signal]);

      const hasBody = body !== undefined;
      const request = new Request(joinUrl(o.url, path), {
        method,
        headers: headers(hasBody ? { "content-type": "application/json" } : undefined),
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal,
      });

      const res = await send(request, opts?.signal, () => deadline.aborted, `${method} ${path}`);

      if (!res.ok) throw errorFromBody(res.status, await res.text().catch(() => ""));

      // 202 {} and 200 {} are both real answers; 204 and an empty body are not JSON.
      const text = await res.text();
      if (text.trim() === "") return undefined as R;
      try {
        return JSON.parse(text) as R;
      } catch (e) {
        throw new OmniError("internal", `${method} ${path} returned a body that is not JSON`, {
          cause: e,
        });
      }
    },

    async open(path: string, opts?: { signal?: AbortSignal }): Promise<Response> {
      opts?.signal?.throwIfAborted();

      // No deadline: an event stream is supposed to stay open, and `requestTimeoutMs` would
      // turn a healthy idle worker into a timeout every 30 seconds.
      const request = new Request(joinUrl(o.url, path), {
        method: "GET",
        headers: headers({ accept: "text/event-stream" }),
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
      });

      const res = await send(request, opts?.signal, () => false, `GET ${path}`);
      if (!res.ok) throw errorFromBody(res.status, await res.text().catch(() => ""));
      return res;
    },
  };
}
