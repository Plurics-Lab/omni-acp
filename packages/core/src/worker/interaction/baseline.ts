import { AcpRequestError, OmniError } from "@omni-acp/protocol";
import type {
  Clock,
  InteractionContext,
  InteractionId,
  InteractionRequest,
  InteractionSnapshot,
  InteractionStrategy,
  MappedPermissionRequest,
  PermissionResponder,
  RequestPermissionResponse,
} from "@omni-acp/protocol";
import { settlementEvents, type SettlementRecord } from "./envelopes.js";

/**
 * M1's `PermissionResponder`, WRAPPED — not widened, not reimplemented (M2-PLAN §1.3 seam A).
 *
 * `InteractionStrategy` supersedes `PermissionResponder` by containing it, so every M1 behaviour
 * is preserved BY CONSTRUCTION rather than by care: the same `decide` call, the same two
 * envelopes in the same order, the same `-32603` on D4 rule 4, the same synthesized `requestId`,
 * and `clientCapabilities: {}` because D10 declares elicitation only under `onUnresolved:"park"`
 * and this strategy never parks.
 *
 * The body it reproduces is `worker.ts`'s `#baselinePermission`, D4 rule 1's forge guard included.
 * The ONE difference is ruling M2-R3's, and review R4 records that it was never avoidable:
 * `acp.interaction` is `payloadVersion: 2` with the NORMALIZED request and the agent's bytes
 * beside it in `raw`, plus §19.10's `kind` / `toolCallId` / `answer.parkedMs`. Nothing else moved,
 * which is what the checked-in M2 golden asserts and what WP-I acceptance 1 actually claims.
 *
 * Owned by M2-A-WP-I.
 */
export function baselineInteractions(r: PermissionResponder, _clock: Clock): InteractionStrategy {
  return {
    // D10: no park ⇒ nobody to ask ⇒ nothing declared. F28 says the agent then asks in prose and
    // ends its turn, which is a degradation and not a hang — declaring a mode we cannot service
    // is the failure that hangs.
    clientCapabilities: Object.freeze({}),

    async permission(
      req: MappedPermissionRequest,
      ctx: InteractionContext,
    ): Promise<RequestPermissionResponse> {
      const decided = r.decide(req);

      // §12.6 / §19.7 rule 1, reproduced verbatim from `worker.ts`: D4's "only ever select an
      // optionId the agent actually offered" is enforced at the one place that emits the answer,
      // and not only inside whichever responder happens to be wired. Corpus 09 is the recording
      // of what a violation costs and its lesson is that it CANNOT be caught downstream — the
      // agent failed every tool call and still ended the turn `end_turn`.
      //
      // The violation folds into rule 4's existing answer — `response: null`, the record stamped
      // `decision: "error"` with `optionId: null`, and `-32603` on the wire — because that is the
      // shape a caller and an auditor already know how to read. Never the invented id (rule 1),
      // and never `outcome: "cancelled"` (rule 5).
      const offeredIds = new Set(req.options.map((o) => o.optionId));
      const selected = decided.record.optionId;
      const forged = decided.response !== null && (selected === null || !offeredIds.has(selected));
      const record = forged
        ? { ...decided.record, decision: "error" as const, optionId: null }
        : decided.record;
      const response = forged ? null : decided.response;

      const interaction: InteractionRequest = {
        // M1's synthesized `perm_<now>_<n>` is KEPT, and that is deliberate: acceptance 1's claim
        // is "identical to M1's modulo `payloadVersion` and the additive fields", and a re-minted
        // `x_<ULID>` here would move a field that is not on that list. The daemon-minted ids
        // (F33) belong to the strategy that can actually be ASKED about one — this one answers
        // `interaction_not_found` to every id, because it parks nothing.
        id: record.requestId,
        kind: "permission",
        method: "session/request_permission",
        title: record.title,
        message: null,
        subject: req.subject,
        options: req.options,
        fields: [],
        toolCallId: req.toolCallId,
        turnId: ctx.turnId,
        raw: req.raw,
      };

      const settlement: SettlementRecord = {
        status: response === null ? "failed" : "answered",
        decision: record.decision,
        by: "baseline",
        byToken: null,
        rule: record.rule,
        // An M1-written decision names no source and is always the baseline's own; saying so is
        // additive and true, where inventing `"default"` would claim a policy document exists.
        ruleSource: "baseline",
        clamped: null,
        optionId: record.optionId,
        action: null,
        contentKeys: null,
        // Nothing the baseline answers was ever parked, so this is 0 by construction rather than
        // by measurement — which is exactly the M1 reading §5.1 asks each widened field to have.
        parkedMs: 0,
        blindsPolicy: false,
      };
      ctx.emit(settlementEvents(interaction, settlement, ctx.turnId));

      if (response === null) {
        // D4 rule 4: nothing acceptable was offered, so we answer with a JSON-RPC error rather
        // than inventing an option id (rule 1) or cancelling the whole turn (rule 5).
        throw AcpRequestError.internalError(
          { offered: record.offered },
          forged
            ? "the selected permission option was not offered"
            : "no acceptable permission option was offered",
        );
      }
      return response;
    },

    /**
     * D10's literal text, and ruling M2-R15's: the handler is registered ALWAYS and answers
     * `{action:"decline"}` — never `-32601`, which is a worse answer for a method the spec
     * defines. It is unreachable in practice because `clientCapabilities` above declares nothing
     * and F28 proves this adapter honours the gate.
     */
    async elicitation(): Promise<unknown> {
      return { action: "decline" };
    },

    answer(id: InteractionId): never {
      throw new OmniError("interaction_not_found", `no interaction ${id} is awaiting an answer`);
    },

    get(): InteractionSnapshot | null {
      return null;
    },

    get pending(): readonly InteractionSnapshot[] {
      return [];
    },

    /** Nothing is ever held open, so there is nothing to settle and nothing to await. */
    async settleAll(): Promise<void> {},

    /** No timers: the park deadline is the only one a strategy owns and this one never parks. */
    close(): void {},
  };
}
