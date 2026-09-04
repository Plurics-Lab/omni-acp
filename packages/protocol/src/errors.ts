import { AcpRequestError } from "./acp.js";
import type { LeaseSnapshot } from "./lease.js";
import type { ResumeReport } from "./resume.js";

/** Exactly DESIGN §5.4. No additions — see CONTRACTS.md §11 D29. */
export const OMNI_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "policy_exceeds_ceiling",
  "worker_not_found",
  "worker_busy",
  "worker_closed",
  "not_resumable",
  "lease_held",
  "worker_limit",
  "agent_error",
  "agent_timeout",
  "internal",
] as const;
export type OmniErrorCode = (typeof OMNI_ERROR_CODES)[number];

/**
 * The ONLY status mapping in the repository. The HTTP layer has no other.
 *
 * A `Record` (not a `Partial`), so a new code without a status is a compile error
 * (M0-PLAN.md §1.3 exit criterion 4).
 */
export const ERROR_STATUS: { readonly [C in OmniErrorCode]: number } = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  policy_exceeds_ceiling: 403,
  worker_not_found: 404,
  worker_busy: 409,
  worker_closed: 410,
  not_resumable: 422,
  lease_held: 423,
  worker_limit: 429,
  agent_error: 502,
  agent_timeout: 504,
  internal: 500,
};

/** The agent's JSON-RPC error, passed through verbatim and never reshaped. */
export interface AcpErrorDetail {
  code: number;
  message: string;
  data?: unknown;
}

export interface OmniErrorBody {
  code: OmniErrorCode;
  message: string;
  acp?: AcpErrorDetail;
  /**
   * ONLY on `lease_held` (423). Says WHO holds it and at which epoch, so a caller does not have
   * to re-GET a worker it may no longer control just to find out (CONTRACTS.md §16.1).
   */
  lease?: LeaseSnapshot;
  /** ONLY on `not_resumable` (422). Which of D2's four states fired, and on what evidence. */
  resume?: ResumeReport;
}

/** True for the AbortController / AbortSignal.timeout families, cross-realm. */
function isAbortLike(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const name = (e as { name?: unknown }).name;
  const code = (e as { code?: unknown }).code;
  return name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR";
}

function messageOf(e: unknown, fallback: string): string {
  if (typeof e === "string" && e.length > 0) return e;
  if (typeof e === "object" && e !== null) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return fallback;
}

/**
 * The repository's one error type.
 *
 * The constructor is real even in the scaffold: every other stub in the repository throws
 * `new OmniError("internal", "unimplemented: WP-n")`, so a throwing constructor would make the
 * scaffold unable to describe itself.
 */
export class OmniError extends Error {
  readonly code: OmniErrorCode;
  readonly status: number;
  readonly acp?: AcpErrorDetail;
  /** Present only on `lease_held`; spread onto the body so two 423s stay deep-equal (§16.1). */
  readonly lease?: LeaseSnapshot;
  /** Present only on `not_resumable`; the evidence behind D2's four-state verdict (§15). */
  readonly resume?: ResumeReport;
  /** Machine-readable extras that never cross the wire (pid, exit code, path...). */
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(
    code: OmniErrorCode,
    message: string,
    opts?: {
      acp?: AcpErrorDetail;
      cause?: unknown;
      detail?: Record<string, unknown>;
      lease?: LeaseSnapshot;
      resume?: ResumeReport;
    },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "OmniError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.acp = opts?.acp;
    this.lease = opts?.lease;
    this.resume = opts?.resume;
    this.detail = opts?.detail;
  }

  /**
   * The wire body (CONTRACTS.md §9). `detail` is deliberately absent: it is the half of an
   * OmniError that is logged and never returned. `acp` is present only when there is one, so
   * two bodies for the same failure are deep-equal.
   */
  toBody(): OmniErrorBody {
    // Each extra is spread only when it exists, so two bodies for the same failure are
    // deep-equal and there is still exactly ONE mapper (§9).
    return {
      code: this.code,
      message: this.message,
      ...(this.acp === undefined ? {} : { acp: this.acp }),
      ...(this.lease === undefined ? {} : { lease: this.lease }),
      ...(this.resume === undefined ? {} : { resume: this.resume }),
    };
  }

  static is(e: unknown, code?: OmniErrorCode): e is OmniError {
    return e instanceof OmniError && (code === undefined || e.code === code);
  }

  /**
   * Never throws. `acp.RequestError` -> agent_error carrying `acp`;
   * AbortError/TimeoutError -> agent_timeout; OmniError -> itself; anything else -> `fallback`
   * (default `internal`).
   */
  static from(e: unknown, fallback?: OmniErrorCode): OmniError {
    if (e instanceof OmniError) return e;

    if (e instanceof AcpRequestError) {
      const acp: AcpErrorDetail =
        e.data === undefined
          ? { code: e.code, message: e.message }
          : { code: e.code, message: e.message, data: e.data };
      return new OmniError("agent_error", e.message, { acp, cause: e });
    }

    if (isAbortLike(e)) {
      return new OmniError("agent_timeout", messageOf(e, "aborted"), { cause: e });
    }

    return new OmniError(fallback ?? "internal", messageOf(e, "internal error"), { cause: e });
  }
}
