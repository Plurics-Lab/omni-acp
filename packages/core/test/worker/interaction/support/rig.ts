import { InteractionConfig } from "@omni-acp/protocol";
import type {
  EventEnvelope,
  EventInput,
  InteractionContext,
  InteractionPayload,
  InteractionStrategy,
  MappedPermissionRequest,
  PermissionOption,
  PolicyDecisionPayload,
  PolicySubject,
  PolicyVerdict,
  ResolvedInteractionConfig,
  WorkerHandle,
  WorkerId,
  WorkerStatePayload,
} from "@omni-acp/protocol";
import { fakeClock, nullLogger, seqIds, type FakeClock } from "@omni-acp/testkit";
import { openAcpLink } from "../../../../src/acp/link.js";
import { createBaselineResponder } from "../../../../src/index.js";
import { mapElicitation } from "../../../../src/normalizer/map/elicitation.js";
import {
  createInteractionStrategy,
  type InteractionStrategyDeps,
} from "../../../../src/worker/interaction/strategy.js";
import { flush, harness, type Harness } from "../../support/harness.js";
import { recordingAgent, type RecordingAgent } from "./recording-agent.js";

/**
 * One worker, one recording agent, one REAL `InteractionStrategy` — the rig every acceptance
 * bullet below §19 is written against.
 *
 * Deliberately end to end through the Land-written `worker.ts`: hunks 2, 3, 4 and 5 are what turn
 * a strategy's `ctx.park()` into `requires_action`, and a test that stubbed the context would
 * assert the strategy against a Worker nobody ships.
 *
 * Not a `*.test.ts` file, so vitest does not collect it.
 */

export const option = (optionId: string, kind: string): PermissionOption =>
  ({ optionId, kind, name: optionId }) as PermissionOption;

export const ALLOW_ONCE = option("allow-once", "allow_once");
export const ALLOW_ALWAYS = option("allow-with-updates", "allow_always");
export const REJECT = option("reject", "reject_once");
export const MENU: readonly PermissionOption[] = [ALLOW_ONCE, ALLOW_ALWAYS, REJECT];

/** Transcript `12`'s `requestedSchema`, byte for byte, as a fixture builder. */
export function elicitationParams(o?: {
  message?: string;
  toolCallId?: string;
  sessionId?: string;
  choices?: readonly string[];
  custom?: boolean;
}): Record<string, unknown> {
  const choices = o?.choices ?? ["notes.md", "README.md", "main.py", "index.js"];
  const properties: Record<string, unknown> = {
    question_0: {
      type: "string",
      title: "File name",
      oneOf: choices.map((c) => ({ const: c, title: c, description: `A file called ${c}` })),
    },
  };
  if (o?.custom !== false) {
    properties["question_0_custom"] = {
      type: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
      _meta: {
        _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true },
      },
    };
  }
  return {
    mode: "form",
    sessionId: o?.sessionId ?? "sess_recording",
    toolCallId: o?.toolCallId ?? "toolu_ask_1",
    message: o?.message ?? "What should the new file be named?",
    requestedSchema: { type: "object", properties },
  };
}

export interface Rig {
  readonly h: Harness;
  readonly agent: RecordingAgent;
  readonly worker: WorkerHandle;
  readonly strategy: InteractionStrategy;
  /** Every envelope the worker's log holds, in order. */
  readonly log: readonly EventEnvelope[];
  interactions(): readonly EventEnvelope[];
  decisions(): readonly EventEnvelope[];
  states(): readonly WorkerStatePayload[];
  ip(n: number): InteractionPayload;
  dp(n: number): PolicyDecisionPayload;
}

export interface RigOptions {
  readonly onUnresolved?: "park" | "deny" | "fail";
  readonly parkTimeoutMs?: number;
  readonly parkTimeoutAction?: "deny" | "fail";
  readonly config?: Partial<ResolvedInteractionConfig>;
  readonly decide?: (s: PolicySubject) => PolicyVerdict;
  readonly strategy?: (deps: InteractionStrategyDeps) => InteractionStrategy;
  /** Default true, as the daemon wiring does it; `false` proves the un-wired diagnosis. */
  readonly withLog?: boolean;
}

export async function rig(o: RigOptions = {}): Promise<Rig> {
  const h = harness();
  const agent = recordingAgent();
  h.supervisor.enqueue(agent as never);

  const config = InteractionConfig.parse(o.config ?? {});
  const deps: InteractionStrategyDeps = {
    workerId: "w_00000000000000000000000001" as never,
    clock: h.clock,
    ids: h.deps().ids,
    logger: h.logger,
    config,
    onUnresolved: o.onUnresolved ?? "park",
    parkTimeoutMs: o.parkTimeoutMs ?? null,
    parkTimeoutAction: o.parkTimeoutAction ?? "deny",
    responder: createBaselineResponder("deny", h.clock),
    ...(o.decide === undefined ? {} : { decide: o.decide }),
    // The daemon wiring hands the strategy the worker's own log, so the rig does too: without
    // it `InteractionAnswerResult.seq` has no envelope to copy and `answer()` says so loudly.
    ...(o.withLog === false ? {} : { log: h.log, workerState: () => worker.snapshot().state }),
  };
  const strategy = (o.strategy ?? createInteractionStrategy)(deps);
  const worker = await h.create({
    overrides: { interactions: strategy, normalizer: normalizerWithRaw(h) },
  });

  return {
    h,
    agent,
    worker,
    strategy,
    get log(): readonly EventEnvelope[] {
      return h.log.all;
    },
    interactions: () => h.log.all.filter((e) => e.kind === "acp.interaction"),
    decisions: () => h.log.all.filter((e) => e.kind === "omni.policy_decision"),
    states: () =>
      h.log.all
        .filter((e) => e.kind === "omni.worker_state")
        .map((e) => e.payload as WorkerStatePayload),
    ip(n) {
      const e = h.log.all.filter((x) => x.kind === "acp.interaction")[n];
      if (e === undefined) throw new Error(`no acp.interaction #${String(n)}`);
      return e.payload as InteractionPayload;
    },
    dp(n) {
      const e = h.log.all.filter((x) => x.kind === "omni.policy_decision")[n];
      if (e === undefined) throw new Error(`no omni.policy_decision #${String(n)}`);
      return e.payload as PolicyDecisionPayload;
    },
  };
}

/**
 * A strategy behind a REAL `AcpLink` and a recording agent, with no `Worker` at all.
 *
 * §19.8's guarantee is about two calls in one order — `settleAll("cancel")` and then
 * `link.notify("session/cancel")` — and the only thing that can observe it is the agent on the
 * other end of the pipe. This rig is `Worker.cancel`'s body with everything else removed.
 */
export interface LinkRig {
  readonly agent: RecordingAgent;
  readonly strategy: InteractionStrategy;
  readonly clock: FakeClock;
  /** Every `EventInput` the strategy emitted, in order. */
  readonly emitted: readonly EventInput[];
  readonly parked: readonly string[];
  notifyCancel(): Promise<void>;
  dispose(): void;
}

export function linkRig(o: RigOptions = {}): LinkRig {
  const agent = recordingAgent();
  const clock = fakeClock();
  const emitted: EventInput[] = [];
  const parked: string[] = [];
  const config = InteractionConfig.parse(o.config ?? {});

  const strategy = createInteractionStrategy({
    workerId: "w_00000000000000000000000001" as WorkerId,
    clock,
    ids: seqIds(),
    logger: nullLogger(),
    config,
    onUnresolved: o.onUnresolved ?? "park",
    parkTimeoutMs: o.parkTimeoutMs ?? null,
    parkTimeoutAction: o.parkTimeoutAction ?? "deny",
    responder: createBaselineResponder("deny", clock),
    ...(o.decide === undefined ? {} : { decide: o.decide }),
  });

  const ctx: InteractionContext = {
    turnId: null,
    emit: (inputs) => {
      emitted.push(...inputs);
    },
    park: (id) => {
      parked.push(id);
      return () => {
        const i = parked.indexOf(id);
        if (i !== -1) parked.splice(i, 1);
      };
    },
    failTurn: () => {},
  };

  const acp = openAcpLink(
    agent.stream,
    {
      onSessionUpdate: () => {},
      onPermissionRequest: (req) =>
        strategy.permission(
          { ...mapForTest(req), raw: req as unknown as Record<string, unknown> },
          ctx,
        ),
      onElicitation: (params) => strategy.elicitation(mapElicitation(params), ctx),
      onClosed: () => {},
    },
    { logger: nullLogger() },
  );

  return {
    agent,
    strategy,
    clock,
    emitted,
    parked,
    notifyCancel: () => acp.notify("session/cancel", { sessionId: "sess_recording" }),
    dispose: () => {
      acp.close();
      agent.die();
    },
  };
}

/** The one row `lifecycle-normalizer.ts` models, inlined so `linkRig` needs no Normalizer. */
function mapForTest(req: unknown): Omit<MappedPermissionRequest, "raw"> {
  const r = (typeof req === "object" && req !== null ? req : {}) as Record<string, unknown>;
  const toolCall = (
    typeof r["toolCall"] === "object" && r["toolCall"] !== null ? r["toolCall"] : null
  ) as Record<string, unknown> | null;
  return {
    sessionId: typeof r["sessionId"] === "string" ? r["sessionId"] : "",
    title: toolCall !== null && typeof toolCall["title"] === "string" ? toolCall["title"] : "",
    subject: toolCall === null ? null : { type: "tool_call", toolCall },
    options: Array.isArray(r["options"]) ? (r["options"] as MappedPermissionRequest["options"]) : [],
    toolCallId:
      toolCall !== null && typeof toolCall["toolCallId"] === "string"
        ? toolCall["toolCallId"]
        : null,
  };
}

/**
 * The harness's lifecycle double, with `MappedPermissionRequest.raw` filled in.
 *
 * `core/test/worker/support/lifecycle-normalizer.ts` predates review R11's `raw` field and is
 * another package's file, so the rig supplies what the REAL `createNormalizer` already supplies
 * (`normalizer/map/permission.ts`: `raw: record(r["raw"]) ?? r`). Without it every
 * `acp.interaction.raw` in this suite would be `undefined` and §7.5's audit — "the agent's bytes,
 * untouched" — would be asserted against a hole.
 */
function normalizerWithRaw(h: Harness): Harness["normalizer"] {
  const base = h.normalizer;
  return {
    ...base,
    mapPermissionRequest: (req: unknown) => ({
      ...base.mapPermissionRequest(req),
      raw: typeof req === "object" && req !== null ? (req as Record<string, unknown>) : {},
    }),
  };
}

export { flush };
