import { AcpRequestError, OmniError } from "@omni-acp/protocol";
import type {
  ClientRef,
  EventEnvelope,
  EventLog,
  InteractionAnswer,
  InteractionAnswerResult,
  InteractionContext,
  InteractionDeps,
  InteractionId,
  InteractionRequest,
  InteractionSnapshot,
  InteractionStrategy,
  MappedElicitationRequest,
  MappedPermissionRequest,
  OptionChoice,
  PermissionOption,
  PolicySubject,
  PolicyVerdict,
  RequestPermissionResponse,
  Seq,
  TokenId,
  WorkerState,
} from "@omni-acp/protocol";
import { buildElicitationContent, mapElicitation } from "../../normalizer/map/elicitation.js";
import { selectOption } from "../permission-responder.js";
import { clientCapabilitiesFor } from "./capability.js";
import { pendingInteractionEvent, settlementEvents, type ParkBlock } from "./envelopes.js";
import { createParkTimer } from "./park.js";
import {
  createPendingInteractions,
  type HeldInteraction,
  type PendingInteractions,
  type Settlement,
} from "./registry.js";

/**
 * M2-A-WP-I's local widening of the frozen `InteractionDeps` (§5.8.8).
 *
 * Every added member is OPTIONAL, so `createInteractionStrategy` stays assignable to
 * `DaemonDeps.interactions: (o: InteractionDeps) => InteractionStrategy` and nothing outside this
 * package has to know they exist. They are here because `InteractionDeps` carries neither the log
 * nor the worker state nor a `cwd`, while `InteractionAnswerResult` asks for the first two by
 * name:
 *
 *  - `log` / `workerState` — `InteractionAnswerResult.{seq,state}`. `InteractionContext.emit` is
 *    contracted `void` and `worker.ts` discards the envelopes it appended, so a settlement's
 *    `seq` is not observable from inside the strategy. Absent, `seq` is `0` — the log's own
 *    "nothing appended yet" value — and `state` is derived from whether anything is still parked.
 *  - `toSubject` — a `PolicySubject` needs a REALPATH'D `paths`, a `cwd` and an `agentId`, none of
 *    which `InteractionDeps` carries; §20.3 makes the realpath a SECURITY property ("a symlink
 *    into `src/` does not satisfy `src/**`"), so building half a subject here would ship a `path`
 *    clause a symlink defeats. Absent, and with `decide` present, the subject is the fail-closed
 *    one: `paths: []`, which §20.3 says matches no `path` clause at all.
 */
export interface InteractionStrategyDeps extends InteractionDeps {
  readonly log?: Pick<EventLog, "head" | "read">;
  readonly workerState?: () => WorkerState;
  readonly toSubject?: (req: InteractionRequest) => PolicySubject | Promise<PolicySubject>;
}

/**
 * The real `InteractionStrategy`: D10's ONE lifecycle over both agent→client requests.
 *
 * It differs from `baselineInteractions` in exactly ONE place — it consults an injected
 * `decide: (subject) => PolicyVerdict`, defaulting to
 * `() => ({action: onUnresolved, rule: "m2:onUnresolved", source: "default", clamped: null})`.
 *
 * That default is the whole of M2-PLAN §1.3's seam A: it is why M2-A-WP-I and M2-B-WP-P are
 * file-disjoint and can land in either order, and why M2-A ships with no policy engine at all —
 * with none, this strategy parks, denies or fails exactly as `CreateWorkerRequest.onUnresolved`
 * asked it to, and the engine is a later narrowing rather than a prerequisite.
 *
 * Owned by M2-A-WP-I.
 */
export function createInteractionStrategy(o: InteractionStrategyDeps): InteractionStrategy {
  const logger = o.logger.child({ component: "interactions", workerId: o.workerId });
  const parkTimeoutMs = o.parkTimeoutMs ?? o.config.parkTimeoutMs;
  /** Every armed park deadline, so `close()` can dispose the lot (review R15). */
  const timers = new Set<{ cancel(): void }>();

  const registry: PendingInteractions = createPendingInteractions({
    maxParked: o.config.maxParked,
    clock: o.clock,
    workerId: o.workerId,
    decideAnswer: (held, a, who) => answerOf(held, a, who),
    decideSettleAll: (held, reason) => settleAllOf(held, reason),
    ...(o.workerState === undefined ? {} : { workerState: o.workerState }),
    cursor: () => newest(o.log),
  });

  return {
    clientCapabilities: clientCapabilitiesFor({ onUnresolved: o.onUnresolved, config: o.config }),

    async permission(
      req: MappedPermissionRequest,
      ctx: InteractionContext,
    ): Promise<RequestPermissionResponse> {
      return (await route(
        permissionRequestOf(o.ids.interaction(), req, ctx),
        ctx,
      )) as RequestPermissionResponse;
    },

    async elicitation(req: MappedElicitationRequest, ctx: InteractionContext): Promise<unknown> {
      // Review R11, and the reason `MappedElicitationRequest.raw` exists: `worker.ts` maps with a
      // Land-step FALLBACK (`fields: []`, everything `unmodelled`) and is frozen afterwards, so
      // the real map runs HERE, from the agent's own bytes. Nothing about the fallback is trusted.
      return await route(elicitationRequestOf(o.ids.interaction(), safeRemap(req), ctx), ctx);
    },

    answer(
      id: InteractionId,
      a: InteractionAnswer,
      who: ClientRef & { tokenId: TokenId },
    ): InteractionAnswerResult {
      return registry.answer(id, a, who);
    },

    get(id: InteractionId): InteractionSnapshot | null {
      return registry.get(id);
    },

    get pending(): readonly InteractionSnapshot[] {
      return registry.pending;
    },

    async settleAll(reason): Promise<void> {
      await registry.settleAll(reason);
    },

    close(): void {
      // Review R15: one surviving timer keeps the whole process alive. Idempotent, and it never
      // throws — a close a dependency can break is a close that leaks a process.
      for (const t of [...timers]) {
        timers.delete(t);
        try {
          t.cancel();
        } catch (e) {
          logger.error("cancelling a park deadline failed", { error: String(e) });
        }
      }
    },
  };

  // ── routing: park, or settle now ───────────────────────────────────────────

  async function route(req: InteractionRequest, ctx: InteractionContext): Promise<unknown> {
    const verdict = await verdictFor(req);
    if (verdict.action !== "park") return settleNow(req, ctx, autoOf(req, verdict));

    if (registry.atCapacity) {
      // §19.5: over `interaction.maxParked` the NEWEST is DENIED and never dropped — an
      // unanswered agent request hangs a turn forever, and a silent drop is the one outcome
      // worse than a denial.
      logger.warn("max_parked reached; denying the newest interaction", {
        requestId: req.id,
        maxParked: o.config.maxParked,
      });
      return settleNow(req, ctx, {
        ...refuse(req, {
          status: "answered",
          by: "daemon",
          byToken: null,
          rule: "limit:max_parked",
          ruleSource: "default",
          parkedMs: 0,
        }),
        failTurn: null,
      });
    }
    return await park(req, ctx);
  }

  /** The auto-resolved arms: two envelopes, in M1's order, and nothing is ever held. */
  function settleNow(req: InteractionRequest, ctx: InteractionContext, d: Decided): unknown {
    ctx.emit(settlementEvents(req, d.record, req.turnId));
    if (d.failTurn !== null) failTurnAfterAnswer(ctx, d.failTurn);
    if (d.wire.kind === "reject") throw d.wire.error;
    return d.wire.value;
  }

  /**
   * §19.8's ordering, applied to the ONE place `fail` and the answer meet.
   *
   * `ctx.failTurn` reaches `Worker.cancelInternal`, which sends `session/cancel`. An agent blocked
   * on our answer may never read that cancel (F1), so the answer must be on its way first — and
   * this function returns to a caller that has not yet returned the answer to the ACP link. A
   * microtask is exactly the gap: the caller's `return` resolves the link's handler promise in
   * this same tick, and `cancelInternal` awaits `settleAll` before it notifies.
   */
  function failTurnAfterAnswer(ctx: InteractionContext, reason: string): void {
    queueMicrotask(() => {
      try {
        ctx.failTurn(reason);
      } catch (e) {
        logger.error("failTurn threw", { error: String(e) });
      }
    });
  }

  /** The park arm. Emits n+0, parks (n+1), arms the deadline, and holds the promise open. */
  async function park(req: InteractionRequest, ctx: InteractionContext): Promise<unknown> {
    const parkedAtMs = o.clock.now();
    const expiresAtMs = parkTimeoutMs > 0 ? parkedAtMs + parkTimeoutMs : null;
    const block: ParkBlock = {
      parkedAt: new Date(parkedAtMs).toISOString(),
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      onTimeout: o.parkTimeoutAction,
    };

    // §19.10's n+0 BEFORE n+1: the request is announced, and only then does the worker move. A
    // consumer that saw `requires_action` with nothing to read would have nothing to render.
    ctx.emit([pendingInteractionEvent(req, block, req.turnId)]);
    const unpark = ctx.park(req.id);

    let fired = false;
    const timer = createParkTimer({
      clock: o.clock,
      timeoutMs: parkTimeoutMs,
      onExpire: () => {
        fired = true;
        expire(req, ctx);
      },
    });
    timers.add(timer);

    return await registry.hold(req, {
      expiresAtMs,
      onTimeout: o.parkTimeoutAction,
      emit: (inputs) => {
        ctx.emit(inputs);
      },
      release: () => {
        timers.delete(timer);
        if (!fired) timer.cancel();
        // LAST, so §19.10's n+4 (`omni.worker_state{interaction_resolved}`) follows n+2 and n+3.
        unpark();
      },
    });
  }

  /** `parkTimeoutMs` elapsed with no human. Ruling M2-R7: `deny` or `fail`, never `allow`. */
  function expire(req: InteractionRequest, ctx: InteractionContext): void {
    const settled = registry.settleOne(
      req.id,
      (held) =>
        refuse(held.request, {
          status: "expired",
          by: "timeout",
          byToken: null,
          rule: `m2:parkTimeout:${o.parkTimeoutAction}`,
          ruleSource: "default",
          parkedMs: held.parkedMs(o.clock.now()),
        }),
      "timeout",
    );
    // False means a human won the race by a tick. Failing the turn on a park that was answered
    // would cancel the very turn the answer just unblocked (M2-R21's argument, one level down).
    if (!settled) return;
    if (o.parkTimeoutAction === "fail") {
      failTurnAfterAnswer(
        ctx,
        `interaction ${req.id} expired after ${String(parkTimeoutMs)}ms with no answer`,
      );
    }
  }

  // ── the verdict ────────────────────────────────────────────────────────────

  async function verdictFor(req: InteractionRequest): Promise<PolicyVerdict> {
    const decide = o.decide;
    if (decide === undefined) return DEFAULT_VERDICT[o.onUnresolved];
    let subject: PolicySubject;
    try {
      subject = await subjectFor(o, req);
    } catch (e) {
      // A subject we could not build is a subject no rule may match. Falling back to
      // `onUnresolved` is the fail-closed answer, and it is LOUD rather than silent.
      logger.error("could not build a policy subject; falling back to onUnresolved", {
        requestId: req.id,
        error: String(e),
      });
      return DEFAULT_VERDICT[o.onUnresolved];
    }
    try {
      return decide(subject);
    } catch (e) {
      logger.error("the policy engine threw; falling back to onUnresolved", {
        requestId: req.id,
        error: String(e),
      });
      return DEFAULT_VERDICT[o.onUnresolved];
    }
  }

  /** `allow` / `deny` / `fail`, plus the elicitation narrowing D10 forces. */
  function autoOf(req: InteractionRequest, verdict: PolicyVerdict): Decided {
    const over = {
      by: "policy" as const,
      byToken: null,
      rule: verdict.rule,
      ruleSource: verdict.source,
      clamped: verdict.clamped,
      parkedMs: 0,
      status: "answered" as const,
    };
    const failTurn = verdict.action === "fail" ? failReason(req, verdict) : null;

    if (req.kind === "elicitation") {
      // There is no content to invent, so `allow` cannot be honoured on this arm — D10's answer
      // is `decline`, and saying so out loud beats an "allow" that answered nothing.
      if (verdict.action === "allow") {
        logger.warn("an allow verdict cannot answer an elicitation; declining", {
          requestId: req.id,
          rule: verdict.rule,
        });
      }
      return { ...refuse(req, over), failTurn };
    }

    if (verdict.action === "allow") {
      const choice = chooseOption("allow", req.options, { allowSessionGrants: true });
      if (choice.optionId !== null) {
        return {
          wire: { kind: "resolve", value: selected(choice.optionId) },
          record: {
            ...over,
            decision: "allow",
            optionId: choice.optionId,
            action: null,
            contentKeys: null,
            blindsPolicy: false,
          },
          failTurn: null,
        };
      }
      // D4 rule 2 downgrades to deny when nothing acceptable is offered — never to "cancelled"
      // (rule 5), which would kill the whole turn over one action.
    }
    return { ...refuse(req, over), failTurn };
  }

  /**
   * A denial, as the wire and the audit both see it: the offered `reject_once` (D4 rule 4's first
   * half) or, when nothing acceptable was offered, `-32603` — never an invented id (rule 1) and
   * never `outcome:"cancelled"` (rule 5). An elicitation's denial is `{action:"decline"}`, which
   * is the same word D10 uses and the same one transcript `13` recorded.
   */
  function refuse(req: InteractionRequest, over: RefuseOptions): Settlement {
    const base = {
      by: over.by,
      byToken: over.byToken,
      rule: over.rule,
      ruleSource: over.ruleSource,
      clamped: over.clamped ?? null,
      parkedMs: over.parkedMs,
      blindsPolicy: false,
      action: null,
      contentKeys: null,
    };
    if (req.kind === "elicitation") {
      return {
        wire: { kind: "resolve", value: { action: "decline" } },
        record: {
          ...base,
          status: over.status,
          decision: "deny",
          optionId: null,
          action: "decline",
        },
      };
    }
    const choice = chooseOption("deny", req.options, { allowSessionGrants: true });
    if (choice.optionId === null) {
      // Rule 4: nothing acceptable was offered. `failed` is the status M1 already used for it, so
      // a settle-time refusal that had a deadline stays `expired`/`cancelled` and an ordinary one
      // becomes `failed` — the word is about WHY there is no option, not about who asked.
      const status = over.status === "answered" ? ("failed" as const) : over.status;
      return {
        wire: {
          kind: "reject",
          error: AcpRequestError.internalError(
            { offered: req.options },
            "no acceptable permission option was offered",
          ),
        },
        record: { ...base, status, decision: "error", optionId: null },
      };
    }
    return {
      wire: { kind: "resolve", value: selected(choice.optionId) },
      record: { ...base, status: over.status, decision: "deny", optionId: choice.optionId },
    };
  }

  // ── H22: a human answer, §19.6's SEMANTICS rows ────────────────────────────

  function answerOf(
    held: HeldInteraction,
    a: InteractionAnswer,
    who: ClientRef & { tokenId: TokenId },
  ): Settlement {
    const req = held.request;
    const over = {
      by: "human" as const,
      byToken: who.tokenId,
      rule: `human:${who.tokenId}`,
      // A human is not a rule SOURCE; naming one would claim a policy document decided this.
      ruleSource: null,
      clamped: null,
      parkedMs: held.parkedMs(o.clock.now()),
    };

    if (req.kind === "permission") {
      if (a.action === "answer") {
        throw new OmniError(
          "bad_request",
          `"answer" is the elicitation verb; interaction ${req.id} is a ` +
            `session/request_permission — use "allow" or "deny"`,
        );
      }
      if (a.action === "deny") return refuse(req, { ...over, status: "answered" });
      if (a.action === "cancel") {
        // D4 rule 5 is absolute: `outcome:"cancelled"` never reaches the wire. A human cancel of
        // a PERMISSION therefore answers `-32603` — the one refusal shape rule 4 already defines
        // — and records itself as a cancel so the audit does not read as a policy denial.
        return {
          wire: {
            kind: "reject",
            error: AcpRequestError.internalError(
              { offered: req.options },
              "the permission request was cancelled by the client",
            ),
          },
          record: {
            ...over,
            status: "cancelled",
            decision: "cancel",
            optionId: null,
            action: null,
            contentKeys: null,
            blindsPolicy: false,
          },
        };
      }
      return allowOf(req, a.optionId, over);
    }

    if (a.action === "allow") {
      throw new OmniError(
        "bad_request",
        `"allow" is the permission verb; interaction ${req.id} is an elicitation/create — ` +
          `use "answer", "deny" or "cancel"`,
      );
    }
    if (a.action === "deny") return refuse(req, { ...over, status: "answered" });
    if (a.action === "cancel") {
      return {
        wire: { kind: "resolve", value: { action: "cancel" } },
        record: {
          ...over,
          status: "cancelled",
          decision: "cancel",
          optionId: null,
          action: "cancel",
          contentKeys: null,
          blindsPolicy: false,
        },
      };
    }

    // F30's rule, and the whole reason `buildElicitationContent` is a function: EXACTLY ONE
    // property per questionId reaches the wire. It throws `bad_request` NAMING the question for
    // an unknown id, for both members of one group, for a value outside `oneOf`/`enum` on a
    // choice with no custom slot, for a wrong JSON type, and for an unanswered `required`.
    const content = buildElicitationContent(req.fields, a.content);
    // KEYS ONLY (§5.8.3): a free-text answer is user content and never enters the log. The keys
    // are the WIRE property names, which is what records whether the custom slot was used — the
    // one thing F30 says an auditor has to be able to see.
    const contentKeys = Object.keys(content).sort();
    return {
      wire: { kind: "resolve", value: { action: "accept", content } },
      record: {
        ...over,
        status: "answered",
        decision: "answer",
        optionId: null,
        action: "accept",
        contentKeys,
        blindsPolicy: false,
      },
    };
  }

  /** A human `allow`, with D4 rules 1, 2 and 3 all enforced against the STORED request. */
  function allowOf(
    req: InteractionRequest,
    optionId: string | undefined,
    over: HumanOptions,
  ): Settlement {
    let chosen: PermissionOption | undefined;
    if (optionId === undefined) {
      // Rule 2's ordering picks when the caller did not: a session-grant id, then `allow_once`.
      const choice = chooseOption("allow", req.options, { allowSessionGrants: true });
      if (choice.optionId === null) {
        throw new OmniError(
          "bad_request",
          `interaction ${req.id} offers no option this daemon may select ` +
            `(${describeOffered(req.options)}); answer "deny" instead`,
        );
      }
      chosen = req.options.find((x) => x.optionId === choice.optionId);
    } else {
      // D4 rule 1, re-checked against the STORED request — the third of §19.7's three independent
      // checks, and the only one a human answer passes through.
      chosen = req.options.find((x) => x.optionId === optionId);
      if (chosen === undefined) {
        throw new OmniError(
          "bad_request",
          `"${optionId}" is not one of the options interaction ${req.id} offered ` +
            `(${describeOffered(req.options)})`,
        );
      }
    }
    if (chosen === undefined) {
      throw new OmniError("internal", `option selection produced no option for ${req.id}`);
    }

    // D4 rule 3, and F26 is the measured cost of breaking it: ONE `allow-with-updates` let the
    // second Write of the same turn complete with NO second permission request, and nothing on
    // the wire announced the grant. `allowAlways:"never"` is the default and applies to EVERY
    // source, a human POST included (ruling M2-R19).
    const blindsPolicy = chosen.kind === "allow_always";
    if (blindsPolicy && o.config.allowAlways !== "human") {
      throw new OmniError(
        "bad_request",
        `"${chosen.optionId}" has kind "allow_always"; D4 rule 3 forbids selecting one, because ` +
          `F26 records that a session-wide grant is announced nowhere on the wire — set ` +
          `interaction.allowAlways: "human" to accept that consequence`,
      );
    }
    if (blindsPolicy) {
      // M2-R19: we cannot un-blind the session; we can refuse to be silent about it.
      logger.warn("a human selected an allow_always option; the policy engine is now blind", {
        requestId: req.id,
        optionId: chosen.optionId,
      });
    }

    return {
      wire: { kind: "resolve", value: selected(chosen.optionId) },
      record: {
        ...over,
        status: "answered",
        decision: "allow",
        optionId: chosen.optionId,
        action: null,
        contentKeys: null,
        blindsPolicy,
      },
    };
  }

  // ── §19.8: settleAll ───────────────────────────────────────────────────────

  function settleAllOf(
    held: HeldInteraction,
    reason: "shutdown" | "cancel" | "close" | "hibernate" | "timeout",
  ): Settlement {
    // §19.8, literally: a REAL answer on the wire for each — `-32603` for a permission,
    // `{action:"decline"}` for an elicitation — because a log that ends on a `pending` interaction
    // is a log that lies and an agent blocked on us waits forever.
    //
    // `-32603` and NOT the offered `reject_once`, deliberately: a teardown is not a policy
    // decision. Answering with an option id would put "we chose to refuse this" in the audit
    // trail for a request nobody ever considered, and `decision: "cancel"` beside it would then
    // contradict the option it names. `expire()` above is the OTHER case and it does pick the
    // offered id, because `parkTimeoutAction` IS a decision (M2-R7).
    const req = held.request;
    const expired = reason === "timeout";
    const base = {
      by: expired ? ("timeout" as const) : ("daemon" as const),
      byToken: null,
      rule: expired ? `m2:parkTimeout:${o.parkTimeoutAction}` : `m2:settle:${reason}`,
      ruleSource: "default" as const,
      clamped: null,
      parkedMs: held.parkedMs(o.clock.now()),
      blindsPolicy: false,
      status: (expired ? "expired" : "cancelled") as "expired" | "cancelled",
      decision: "cancel" as const,
      optionId: null,
    };
    if (req.kind === "elicitation") {
      return {
        wire: { kind: "resolve", value: { action: "decline" } },
        record: { ...base, action: "decline", contentKeys: null },
      };
    }
    return {
      wire: {
        kind: "reject",
        error: AcpRequestError.internalError(
          { offered: req.options },
          `the permission request was abandoned (${reason})`,
        ),
      },
      record: { ...base, action: null, contentKeys: null },
    };
  }

  function failReason(req: InteractionRequest, verdict: PolicyVerdict): string {
    return `policy ${verdict.rule} failed interaction ${req.id} (${req.method})`;
  }
}

// ── free helpers ─────────────────────────────────────────────────────────────

interface RefuseOptions {
  readonly status: "answered" | "expired" | "cancelled";
  readonly by: "policy" | "human" | "timeout" | "daemon" | "baseline";
  readonly byToken: TokenId | null;
  readonly rule: string;
  readonly ruleSource: PolicyVerdict["source"] | null;
  readonly parkedMs: number;
  readonly clamped?: PolicyVerdict["clamped"];
}

interface HumanOptions {
  readonly by: "human";
  readonly byToken: TokenId;
  readonly rule: string;
  readonly ruleSource: null;
  readonly clamped: null;
  readonly parkedMs: number;
}

interface Decided extends Settlement {
  /** The `ctx.failTurn` reason, or null. Applied AFTER the answer (M2-R24, §19.8). */
  readonly failTurn: string | null;
}

/** Seam A's default: `onUnresolved`, verbatim, as a verdict. */
const DEFAULT_VERDICT: Readonly<Record<"park" | "deny" | "fail", PolicyVerdict>> = Object.freeze({
  park: { action: "park", rule: "m2:onUnresolved", source: "default", clamped: null },
  deny: { action: "deny", rule: "m2:onUnresolved", source: "default", clamped: null },
  fail: { action: "fail", rule: "m2:onUnresolved", source: "default", clamped: null },
});

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

function describeOffered(options: readonly PermissionOption[]): string {
  return options.length === 0
    ? "it offered none"
    : `offered: ${options.map((x) => `"${x.optionId}"`).join(", ")}`;
}

function permissionRequestOf(
  id: InteractionId,
  req: MappedPermissionRequest,
  ctx: InteractionContext,
): InteractionRequest {
  return {
    id,
    kind: "permission",
    method: "session/request_permission",
    title: req.title,
    message: null,
    subject: req.subject,
    options: req.options,
    fields: [],
    toolCallId: req.toolCallId,
    turnId: ctx.turnId,
    raw: req.raw,
  };
}

function elicitationRequestOf(
  id: InteractionId,
  req: MappedElicitationRequest,
  ctx: InteractionContext,
): InteractionRequest {
  return {
    id,
    kind: "elicitation",
    method: "elicitation/create",
    // v1's elicitation carries no title of its own, so the message IS the title a UI shows — and
    // the message is kept beside it rather than moved away.
    title: req.message,
    message: req.message,
    // A permission's tagged subject; an elicitation has none, and D4 says an unknown subject falls
    // to `default`. `null` is the honest value; an empty object would be a subject that matches.
    subject: null,
    options: [],
    fields: req.fields,
    // F29's FLAT `toolCallId` — the join to F32's `AskUserQuestion` tool-call mirror, and the
    // reason the same interaction is never counted twice.
    toolCallId: req.toolCallId,
    turnId: ctx.turnId,
    raw: req.raw,
  };
}

/**
 * `mapElicitation` from `req.raw`, TOTALLY.
 *
 * §5.8.9 contracts the mapper as total, and it is — except for F29's one deliberate throw, the
 * nested `scope`. A request we cannot map is still a request an agent is blocked on (F1), so the
 * honest shape is the one §19.4 names: `fields: []` with every property in `unmodelled`, which
 * makes `answer` impossible and leaves `deny` and `cancel` possible.
 */
function safeRemap(req: MappedElicitationRequest): MappedElicitationRequest {
  try {
    return mapElicitation(req.raw);
  } catch {
    return { ...req, fields: [] };
  }
}

/**
 * The subject a `decide` sees. See `InteractionStrategyDeps.toSubject` for why the fallback is
 * `paths: []`: §20.3 says a `path` clause matches only when `paths` is NON-EMPTY and every entry
 * matches, so an un-realpath'd subject can never launder a rule it should not satisfy.
 */
async function subjectFor(
  o: InteractionStrategyDeps,
  req: InteractionRequest,
): Promise<PolicySubject> {
  if (o.toSubject !== undefined) return await o.toSubject(req);
  const toolCall = asRecord(asRecord(req.subject)["toolCall"]);
  const kind = toolCall["kind"];
  return {
    method: req.method,
    type: req.subject === null ? "unknown" : "tool_call",
    kind: typeof kind === "string" ? kind : null,
    paths: [],
    command: null,
    title: req.title,
    agentId: "",
    cwd: "",
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * The newest envelope in the worker's log, for `InteractionAnswerResult.seq`.
 *
 * The ENVELOPE and not the number: `EventLog.append()` is the only assigner of a `seq` (§8.2) and
 * the `seq-single-writer` guard fails the build on anything that computes one, so the answer's
 * cursor is copied off a row the log itself stamped. A settlement has just appended two or three
 * envelopes when this runs, so the newest of them is the settlement's own.
 */
function newest(log: Pick<EventLog, "head" | "read"> | undefined): EventEnvelope | null {
  if (log === undefined) return null;
  const head = log.head;
  if (head <= 0) return null;
  return log.read((head - 1) as Seq, 1)[0] ?? null;
}

/**
 * §19.7 rule 2's ONE implementation of the allow ordering, resolved ONCE and lazily.
 *
 * `selectOption` lives in `permission-responder.ts` — M2-B-WP-P's file — and still throws
 * `unimplemented` at this commit, so the probe picks the real one the moment WP-P lands its body
 * and uses the identical rules until then. The rules are D4's, in D4's order: a known
 * session-grant id, then any `allow_once`, and NEVER an `allow_always` by any path (rule 3);
 * `deny` is the offered `reject_once` and nothing else (rule 4).
 */
const SESSION_GRANT_OPTION_IDS: ReadonlySet<string> = new Set([
  "allow_session",
  "approve_for_session",
]);

type SelectFn = (
  action: "allow" | "deny",
  offered: readonly PermissionOption[],
  cfg: { allowSessionGrants: boolean },
) => OptionChoice;

const localSelectOption: SelectFn = (action, offered, cfg) => {
  if (action === "deny") {
    const reject = offered.find((x) => x.kind === "reject_once");
    return reject === undefined
      ? { optionId: null, rule: "d4:rule4-nothing-offered" }
      : { optionId: reject.optionId, rule: "d4:rule4-reject-once" };
  }
  if (cfg.allowSessionGrants) {
    const grant = offered.find(
      (x) => SESSION_GRANT_OPTION_IDS.has(x.optionId) && x.kind !== "allow_always",
    );
    if (grant !== undefined) return { optionId: grant.optionId, rule: "d4:rule2-session-grant" };
  }
  const once = offered.find((x) => x.kind === "allow_once");
  return once === undefined
    ? { optionId: null, rule: "d4:rule2-nothing-offered" }
    : { optionId: once.optionId, rule: "d4:rule2-allow-once" };
};

let resolvedSelect: SelectFn | null = null;

function chooseOption(
  action: "allow" | "deny",
  offered: readonly PermissionOption[],
  cfg: { allowSessionGrants: boolean },
): OptionChoice {
  if (resolvedSelect === null) {
    try {
      // A deterministic probe with the one input whose answer is contracted: an empty menu is
      // rule 4's "nothing acceptable was offered", i.e. `optionId: null` — never a throw.
      selectOption("deny", [], { allowSessionGrants: true });
      resolvedSelect = selectOption;
    } catch {
      resolvedSelect = localSelectOption;
    }
  }
  return resolvedSelect(action, offered, cfg);
}
