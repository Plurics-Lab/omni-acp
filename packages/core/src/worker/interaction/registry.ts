import { OmniError } from "@omni-acp/protocol";
import type {
  InteractionAnswer,
  InteractionAnswerResult,
  InteractionId,
  InteractionRequest,
  InteractionSnapshot,
  TokenId,
  ClientRef,
} from "@omni-acp/protocol";

/**
 * The pending set, and the JSON-RPC promises it is holding open.
 *
 * Every entry here is an agent BLOCKED on our answer (F1), which is why `settleAll` must put a
 * real answer on the wire for each and return only once every held promise has resolved — a log
 * that ends on a `pending` interaction is a log that lies, and an agent waiting on us may never
 * read a `session/cancel` we send first (§19.8).
 *
 * `interaction.maxParked` is enforced here: over the bound the NEWEST is denied with
 * `rule:"limit:max_parked"` and never dropped, because an unanswered agent request hangs a turn
 * forever and a silent drop is the one outcome worse than a denial.
 *
 * Owned by M2-A-WP-I.
 */
export interface PendingInteractions {
  /** Registers a request and returns the promise the link handler will await. */
  hold(req: InteractionRequest): Promise<unknown>;
  answer(
    id: InteractionId,
    a: InteractionAnswer,
    who: ClientRef & { tokenId: TokenId },
  ): InteractionAnswerResult;
  get(id: InteractionId): InteractionSnapshot | null;
  readonly pending: readonly InteractionSnapshot[];
  settleAll(reason: "shutdown" | "cancel" | "close" | "hibernate" | "timeout"): void;
}

export function createPendingInteractions(_o: { readonly maxParked: number }): PendingInteractions {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
