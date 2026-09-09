import { OmniError } from "@omni-acp/protocol";
import type {
  ElicitationField,
  EventEnvelope,
  InteractionAnswerResult,
  InteractionId,
  InteractionMethod,
  InteractionSnapshot,
  PermissionOption,
  WorkerId,
} from "@omni-acp/protocol";
import type { Transport } from "./transport.js";

/**
 * DESIGN §9.1's literal line — `worker.on("interaction", req => req.allow())` — made a handle.
 *
 * `kind` is the stable field on an option, never `name` (F27): the name is prose, and prose is
 * not something a program may branch on.
 *
 * `deny()` is ONE verb for both arms because D10 says one lifecycle: a permission denial picks
 * the offered `reject_once`, an elicitation sends `{action:"decline"}`, and a caller should not
 * have to know which arrived to say no.
 *
 * `answer()` is keyed by QUESTION id, and the SDK never sends both a selection and its `_custom`
 * twin (F30) — the daemon re-checks, because the agent reads the custom slot in preference and a
 * client that filled both would silently get the other answer.
 */
export interface InteractionRequestHandle {
  readonly requestId: InteractionId;
  readonly method: InteractionMethod;
  readonly title: string;
  /** `""` for a permission — an empty string, not a null: there IS no message on that arm. */
  readonly message: string;
  readonly options: readonly PermissionOption[];
  /** One entry per QUESTION, not per schema property (F30). `[]` for a permission. */
  readonly fields: readonly ElicitationField[];
  readonly expiresAt: string | null;
  readonly settled: boolean;
  /** D4 rule 2's ordering picks the option when `optionId` is omitted; the daemon re-checks. */
  allow(optionId?: string): Promise<InteractionAnswerResult>;
  deny(): Promise<InteractionAnswerResult>;
  answer(
    content: Record<string, string | number | boolean | string[]>,
  ): Promise<InteractionAnswerResult>;
  /** `{action:"cancel"}` on the INTERACTION. Not a turn cancel — `worker.cancel()` is that. */
  cancel(): Promise<InteractionAnswerResult>;
}

export interface InteractionChannel {
  readonly pending: readonly InteractionSnapshot[];
  /**
   * Fed every envelope the handle ingests. It fires `interaction` for a `pending` one — i.e. ONLY
   * for a PARKED one — and `settled` for every terminal status. An auto-resolved interaction is
   * emitted once, already terminal, so it never fires `interaction`: nothing is being asked of
   * the user, and waking a UI for it would train people to ignore the event.
   */
  handleEnvelope(e: EventEnvelope): void;
  onInteraction(cb: (req: InteractionRequestHandle) => void): () => void;
  onSettled(cb: (s: InteractionSnapshot) => void): () => void;
}

/**
 * `client/src/worker.ts` stays FROZEN because each feature gets its own CHANNEL file, exactly as
 * M1 already did for `client/src/lease.ts` (M2-PLAN §1.4).
 *
 * Owned by M2-A-WP-I.
 */
export function createInteractionChannel(_transport: Transport, _id: WorkerId): InteractionChannel {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
