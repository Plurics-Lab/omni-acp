import { OmniError } from "@omni-acp/protocol";
import type {
  ElicitationField,
  EventEnvelope,
  InteractionAnswerBody,
  InteractionAnswerResult,
  InteractionId,
  InteractionMethod,
  InteractionPayload,
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
 * The pending set is built from the envelope TAIL and never from a poll: `acp.interaction` is on
 * the same stream the handle already consumes, `pending` MEANS parked (ruling M2-R5), and a
 * second `GET …/interactions` round trip could only ever disagree with it. The route is still
 * there for a client that has no stream open — that is what makes it ungated (rule L2).
 *
 * Owned by M2-A-WP-I.
 */
export function createInteractionChannel(transport: Transport, id: WorkerId): InteractionChannel {
  /** Insertion-ordered, so `pending` reads in the order the questions were asked. */
  const pending = new Map<InteractionId, InteractionSnapshot>();
  const onInteraction = new Set<(req: InteractionRequestHandle) => void>();
  const onSettled = new Set<(s: InteractionSnapshot) => void>();

  const post = (
    requestId: InteractionId,
    body: InteractionAnswerBody,
  ): Promise<InteractionAnswerResult> =>
    transport.request<InteractionAnswerResult>(
      "POST",
      `/v1/workers/${id}/interactions/${requestId}`,
      body,
    );

  const handleOf = (snapshot: InteractionSnapshot): InteractionRequestHandle => ({
    requestId: snapshot.requestId,
    method: snapshot.method,
    title: snapshot.title,
    // `""` and not null: a permission has no message, and a UI that had to null-check one field
    // per arm would be a UI that knows which arm arrived — which is what D10 removes.
    message: snapshot.message ?? "",
    options: snapshot.options,
    fields: snapshot.fields,
    expiresAt: snapshot.expiresAt,
    get settled(): boolean {
      return !pending.has(snapshot.requestId);
    },
    allow: (optionId) =>
      post(
        snapshot.requestId,
        optionId === undefined ? { action: "allow" } : { action: "allow", optionId },
      ),
    deny: () => post(snapshot.requestId, { action: "deny" }),
    answer: (content) => {
      // F30, enforced BEFORE the round trip: answers are keyed by QUESTION id, and naming a
      // `_custom` slot is naming a wire property. The daemon re-checks — three independent
      // checks, because a client that filled both silently gets the other answer.
      const customs = new Set(
        snapshot.fields.map((f) => f.customField).filter((f): f is string => f !== null),
      );
      for (const key of Object.keys(content)) {
        if (!customs.has(key)) continue;
        throw new OmniError(
          "bad_request",
          `answers are keyed by QUESTION id: "${key}" is a custom slot — answer the question it ` +
            "belongs to and the daemon decides which property reaches the wire (F30)",
        );
      }
      return post(snapshot.requestId, { action: "answer", content });
    },
    cancel: () => post(snapshot.requestId, { action: "cancel" }),
  });

  return {
    get pending(): readonly InteractionSnapshot[] {
      return [...pending.values()];
    },

    handleEnvelope(e: EventEnvelope): void {
      if (e.kind !== "acp.interaction") return;
      const payload = e.payload as InteractionPayload;
      if (payload.status === "pending") {
        // §19.10: an `acp.interaction` for ONE requestId may appear TWICE, so this keys on the id
        // and never counts frames. A duplicate `pending` (an SSE reconnect replaying the tail)
        // must not fire the listener again.
        if (pending.has(payload.requestId)) return;
        const snapshot = snapshotOf(payload, e, id);
        pending.set(payload.requestId, snapshot);
        const handle = handleOf(snapshot);
        for (const cb of onInteraction) safely(() => cb(handle));
        return;
      }
      const known = pending.get(payload.requestId);
      pending.delete(payload.requestId);
      const settled = { ...snapshotOf(payload, e, id), ...terminalOf(known, payload, e) };
      for (const cb of onSettled) safely(() => cb(settled));
    },

    onInteraction(cb): () => void {
      onInteraction.add(cb);
      return () => onInteraction.delete(cb);
    },

    onSettled(cb): () => void {
      onSettled.add(cb);
      return () => onSettled.delete(cb);
    },
  };
}

/**
 * One envelope → the snapshot a route would have returned.
 *
 * `InteractionSnapshot` is what `GET …/interactions` serves and what `POST` answers with, so the
 * stream-derived view is built in that shape rather than in a second one — a client that read
 * `worker.interactions` and then polled the route must not see two different objects.
 */
function snapshotOf(
  payload: InteractionPayload,
  e: EventEnvelope,
  workerId: WorkerId,
): InteractionSnapshot {
  const request = asRecord(payload.request);
  const kind = payload.kind ?? "permission";
  return {
    requestId: payload.requestId,
    workerId,
    kind,
    method: payload.method,
    status: payload.status,
    title: typeof request["title"] === "string" ? request["title"] : messageOf(request),
    message: kind === "elicitation" ? messageOf(request) : null,
    turnId: e.turnId,
    toolCallId: payload.toolCallId ?? null,
    createdAt: payload.park?.parkedAt ?? e.ts,
    options: Array.isArray(request["options"])
      ? (request["options"] as readonly PermissionOption[])
      : [],
    fields: Array.isArray(request["fields"])
      ? (request["fields"] as readonly ElicitationField[])
      : [],
    expiresAt: payload.status === "pending" ? (payload.park?.expiresAt ?? null) : null,
    settledAt: payload.status === "pending" ? null : e.ts,
    settledBy: payload.answer?.by ?? null,
    answer: payload.answer ?? null,
  };
}

/**
 * The terminal frame's own view, widened with what the PENDING frame carried.
 *
 * A settlement envelope repeats `request` and `raw`, but a client that only ever saw the terminal
 * frame — an auto-resolved interaction, or a stream opened after the park — still gets a complete
 * row; one that saw both keeps the park's `createdAt` rather than the settlement's `ts`.
 */
function terminalOf(
  known: InteractionSnapshot | undefined,
  payload: InteractionPayload,
  e: EventEnvelope,
): Partial<InteractionSnapshot> {
  return {
    ...(known === undefined ? {} : { createdAt: known.createdAt, turnId: known.turnId }),
    settledAt: e.ts,
    settledBy: payload.answer?.by ?? "daemon",
    expiresAt: null,
  };
}

function messageOf(request: Record<string, unknown>): string {
  return typeof request["message"] === "string" ? request["message"] : "";
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** A listener that throws must not take the stream down with it (the `bus` contract). */
function safely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Deliberately swallowed: `client/src/worker.ts` does the same for every other arm, and an
    // exception in one UI callback is not a reason to stop delivering envelopes to the others.
  }
}
