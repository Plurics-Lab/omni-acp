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
}

/**
 * The repository's one error type.
 *
 * The constructor is real even in the scaffold: every other stub in the repository throws
 * `new OmniError("internal", "unimplemented: WP-n")`, so a throwing constructor would make the
 * scaffold unable to describe itself. The behavioural members below are WP-1's.
 */
export class OmniError extends Error {
  readonly code: OmniErrorCode;
  readonly status: number;
  readonly acp?: AcpErrorDetail;
  /** Machine-readable extras that never cross the wire (pid, exit code, path...). */
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(
    code: OmniErrorCode,
    message: string,
    opts?: { acp?: AcpErrorDetail; cause?: unknown; detail?: Record<string, unknown> },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "OmniError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.acp = opts?.acp;
    this.detail = opts?.detail;
  }

  toBody(): OmniErrorBody {
    throw new OmniError("internal", "unimplemented: WP-1 (errors.OmniError#toBody)");
  }

  static is(e: unknown, code?: OmniErrorCode): e is OmniError {
    throw new OmniError("internal", "unimplemented: WP-1 (errors.OmniError.is)");
  }

  /**
   * Never throws. `acp.RequestError` -> agent_error carrying `acp`;
   * AbortError/TimeoutError -> agent_timeout; OmniError -> itself; anything else -> internal.
   */
  static from(e: unknown, fallback?: OmniErrorCode): OmniError {
    throw new OmniError("internal", "unimplemented: WP-1 (errors.OmniError.from)");
  }
}
