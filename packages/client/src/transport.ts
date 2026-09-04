import {
  HEADER,
  OMNI_ERROR_CODES,
  OmniError,
  createIdGen,
  type ClientId,
  type LeaseSnapshot,
  type OmniErrorCode,
  type ResumeReport,
} from "@omni-acp/protocol";

export interface TransportOptions {
  readonly url: string;
  readonly token: string;
  /**
   * Absent ⇒ a fresh ULID, minted HERE, once per transport — which is to say once per
   * `connect()` (CONTRACTS.md §5.7, §16.1 rule L4).
   *
   * Per connection and not per process: two `OmniACP.connect()` calls with one token are two
   * CONTROLLERS, and D5's whole point is that the second one is refused with a `423` naming the
   * first rather than silently sharing its turn. A process-wide id would make the acceptance
   * script's two clients indistinguishable to the lease.
   */
  readonly clientId?: ClientId;
  /** Injectable. Tests pass `daemon.fetch` and touch no socket at all. */
  readonly fetch: typeof globalThis.fetch;
  readonly requestTimeoutMs: number;
}

export interface Transport {
  /** The `Omni-Client-Id` every request carries. Stable for the life of this transport. */
  readonly clientId: ClientId;
  /**
   * JSON in, JSON out, error bodies mapped back to `OmniError` with the code intact.
   *
   * `timeoutMs` overrides `requestTimeoutMs` for ONE call. It exists for the wake path and
   * nothing else: `hibernate.wakeTimeoutMs` defaults to 90 s while the client deadline defaults
   * to 30 s, so a `prompt()` that auto-wakes a hibernated worker would otherwise abandon a wake
   * that was going to succeed — and the daemon would finish it anyway, with nobody listening.
   */
  request<R = unknown>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<R>;
  /** SSE: no request timeout applies, and the caller owns the AbortSignal. */
  open(path: string, opts?: { signal?: AbortSignal }): Promise<Response>;
  /**
   * The fencing token this transport sends as `Omni-Lease-Epoch`, or `null` when it has never
   * held the lease on anything (§16.1 rule L7).
   *
   * It is deliberately the epoch at which THIS CLIENT was last the holder, never the latest
   * epoch it has observed. A transport that adopted the epoch off a `steal` it did not perform
   * would fence itself back IN the moment it watched somebody take the worker away — which is
   * precisely the silent hijack the fence exists to prevent.
   */
  readonly leaseEpoch: number | null;
  /** Called by the worker handle when a lease answer names US as the holder. */
  adoptLeaseEpoch(lease: LeaseSnapshot): void;
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

/**
 * `body.lease` off a `423`, or `body.resume` off a `422` — the two extras `OmniErrorBody` carries
 * and the SDK's only chance to see them (CONTRACTS.md §5.7, §9).
 *
 * Checked shallowly and then passed through by identity, for the same reason `sse-parse.ts`
 * forwards agent payloads verbatim: these are OUR shapes, but they are widened by later
 * milestones, and a client that rebuilt them field by field would silently drop whatever this
 * version has not enumerated. The guard is only strong enough that `error.lease.epoch` is a
 * number when it is present at all.
 */
function leaseOf(v: unknown): LeaseSnapshot | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const lease = v as Partial<LeaseSnapshot>;
  return typeof lease.epoch === "number" && typeof lease.workerId === "string"
    ? (v as LeaseSnapshot)
    : undefined;
}

function resumeOf(v: unknown): ResumeReport | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const resume = v as Partial<ResumeReport>;
  return typeof resume.outcome === "string" && typeof resume.rule === "string"
    ? (v as ResumeReport)
    : undefined;
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

  // §16.1 rule L10 and §15.5: a `423` names the holder and the epoch, and a `422` carries the
  // `ResumeReport` that explains which of D2's four states fired. Both exist so a caller learns
  // WHY from the failure itself, without a second round trip against a worker it may no longer
  // control — so lifting them here is the difference between the SDK exposing the contract and
  // the SDK hiding it behind a JSON blob.
  const lease = leaseOf(body["lease"]);
  const resume = resumeOf(body["resume"]);

  return new OmniError(code, message, {
    ...(hasAcp ? { acp: acp as { code: number; message: string; data?: unknown } } : {}),
    ...(lease === undefined ? {} : { lease }),
    ...(resume === undefined ? {} : { resume }),
    detail: { status },
  });
}

/**
 * One ULID per transport. `createIdGen` is protocol's own monotonic generator — the SDK does not
 * get a second implementation of an id format the daemon validates.
 */
const clientIds = createIdGen();

/**
 * The bearer token travels in the `Authorization` header and NEVER in a URL — not even for SSE,
 * where a query parameter would be the convenient thing and would end up in every proxy log
 * (CONTRACTS.md §8.4).
 */
export function createTransport(o: TransportOptions): Transport {
  if (o.url.trim() === "") throw new OmniError("bad_request", "connect() needs a url");
  if (o.token === "") throw new OmniError("bad_request", "connect() needs a token");

  const clientId: ClientId = o.clientId ?? `c_${clientIds.request()}`;
  let leaseEpoch: number | null = null;

  const headers = (extra?: Record<string, string>): Headers =>
    new Headers({
      [HEADER.auth]: `Bearer ${o.token}`,
      [HEADER.clientId]: clientId,
      // Sent only once this client has actually held a lease. Absent means "no fence", which is
      // what a pure observer wants: rule L2's ungated verbs must not start failing because a
      // reader once cached a number (§16.1).
      ...(leaseEpoch === null ? {} : { [HEADER.leaseEpoch]: String(leaseEpoch) }),
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
    budgetMs: number,
  ): Promise<Response> => {
    try {
      return await o.fetch(request);
    } catch (e) {
      if (caller?.aborted === true) throw caller.reason;
      if (timedOut()) {
        throw new OmniError("agent_timeout", `${describe} timed out after ${String(budgetMs)}ms`, {
          cause: e,
        });
      }
      throw OmniError.from(e, "internal");
    }
  };

  return {
    clientId,

    get leaseEpoch(): number | null {
      return leaseEpoch;
    },

    adoptLeaseEpoch(lease: LeaseSnapshot): void {
      // ONLY when the answer names us. See `Transport.leaseEpoch`: adopting somebody else's
      // epoch would un-fence this client the instant it observed being preempted.
      if (lease.holder?.clientId === clientId) leaseEpoch = lease.epoch;
    },

    async request<R = unknown>(
      method: string,
      path: string,
      body?: unknown,
      opts?: { signal?: AbortSignal; timeoutMs?: number },
    ): Promise<R> {
      opts?.signal?.throwIfAborted();

      const budgetMs = opts?.timeoutMs ?? o.requestTimeoutMs;
      const deadline = AbortSignal.timeout(budgetMs);
      const signal =
        opts?.signal === undefined ? deadline : AbortSignal.any([deadline, opts.signal]);

      const hasBody = body !== undefined;
      const request = new Request(joinUrl(o.url, path), {
        method,
        headers: headers(hasBody ? { "content-type": "application/json" } : undefined),
        ...(hasBody ? { body: JSON.stringify(body) } : {}),
        signal,
      });

      const res = await send(
        request,
        opts?.signal,
        () => deadline.aborted,
        `${method} ${path}`,
        budgetMs,
      );

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

      const res = await send(request, opts?.signal, () => false, `GET ${path}`, 0);
      if (!res.ok) throw errorFromBody(res.status, await res.text().catch(() => ""));
      return res;
    },
  };
}
