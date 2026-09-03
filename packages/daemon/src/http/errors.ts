import { OmniError, type OmniErrorBody } from "@omni-acp/protocol";

/**
 * The single error mapper. It reads `ERROR_STATUS` and nothing else — there is no other status
 * logic anywhere in the HTTP layer, which is what keeps the adapter free of domain judgement
 * (CONTRACTS.md §9, D15 constraint 1).
 *
 * The agent's JSON-RPC error travels in `acp` verbatim and is never reshaped.
 */
export function toErrorResponse(e: unknown): { status: number; body: OmniErrorBody } {
  throw new OmniError("internal", "unimplemented: WP-5 (http.toErrorResponse)");
}
