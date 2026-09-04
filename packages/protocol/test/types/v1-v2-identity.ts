/**
 * A TYPE fixture, not a test: it is never executed. `turn.test.ts` type-checks it with the
 * TypeScript compiler API and asserts ZERO diagnostics, exactly as `id-discrimination.ts` is
 * checked by `id-types.test.ts`.
 *
 * What it proves is CONTRACTS.md §12.3's `=` column: the rows the map forwards BY IDENTITY are
 * forwarded by identity because the v1 and v2 types really are structurally equal — not because
 * nobody has checked. §12.7's table calls for exactly this ("v1 and v2 types verified
 * structurally equal, and asserted at COMPILE time"), and it is the one claim in the map that a
 * runtime test cannot make: two shapes can agree on every recorded payload and still differ.
 *
 * IT ALSO CORRECTS §12.3 ROW 13. Three of the six `=` rows are NOT structurally identical, and
 * each `false` below names the nested type that differs. None of them changes what the map does
 * — an `=` row is forwarded by identity either way — but "verified structurally equal" is a
 * claim, and three sixths of it is not true. See M1-WP-B's hand-off notes.
 *
 * The mechanism is mutual assignability. `Mutual<A, B>` is `true` only when each type is
 * assignable to the other. Rows asserted `false` are asserted `false` DELIBERATELY, so a future
 * SDK that quietly aligned them would fail here rather than pass silently.
 *
 * It imports the BUILT declarations, so what is proven is what consumers get.
 */
import type { V1SessionUpdate, V2SessionUpdate } from "../../dist/index.js";

/** One arm of a `sessionUpdate` union, with the discriminant removed. */
type ArmV1<K extends string> = Extract<V1SessionUpdate, { sessionUpdate: K }>;
type ArmV2<K extends string> = Extract<V2SessionUpdate, { sessionUpdate: K }>;
type BodyV1<K extends string> = Omit<ArmV1<K>, "sessionUpdate">;
type BodyV2<K extends string> = Omit<ArmV2<K>, "sessionUpdate">;

type Assignable<A, B> = [A] extends [B] ? true : false;
type Mutual<A, B> =
  Assignable<A, B> extends true ? (Assignable<B, A> extends true ? true : false) : false;
type IsNever<T> = [T] extends [never] ? true : false;
type IsOptional<T, K extends keyof T> = undefined extends T[K] ? true : false;

/** `true` iff the two spellings of one kind are structurally the same type. */
type SameArm<K extends string> = Mutual<BodyV1<K>, BodyV2<K>>;

// ── §12.3 row 13 and rows 9-10: the `=` rows that ARE identical ──────────────

const sessionInfoUpdate: SameArm<"session_info_update"> = true;
const usageUpdate: SameArm<"usage_update"> = true;
const planRemoved: SameArm<"plan_removed"> = true;

// ── …and the three that are NOT, each with the nested type that differs ──────

/**
 * Row 13's `compaction_*`: the arms' OWN fields are identical field for field. What differs is
 * `ContentBlock`, which both of them carry — v2 added arms v1 does not have. The map is still
 * right to forward these by identity: a v1 `ContentBlock` is a subset of a v2 one, so a payload
 * that was valid v1 is valid v2.
 */
const compactionUpdate: SameArm<"compaction_update"> = false;
const compactionSummaryChunk: SameArm<"compaction_summary_chunk"> = false;
const contentBlockDiffers: Mutual<
  ArmV1<"compaction_summary_chunk">["content"],
  ArmV2<"compaction_summary_chunk">["content"]
> = false;
/** …and it differs in the safe direction: every v1 block is a legal v2 block. */
const v1ContentIsV2Content: Assignable<
  ArmV1<"compaction_summary_chunk">["content"],
  ArmV2<"compaction_summary_chunk">["content"]
> = true;

/**
 * Row 10's `available_commands_update`: same story, one level down. v1's `AvailableCommandInput`
 * is the bare `{hint}`; v2's is a TAGGED union whose first arm is `{type:"text", …}`. Forwarding
 * is still correct — §12.3 row 10 is `=` "on the wire" and ruling M1-R3 is about STORAGE, not
 * about a rewrite — but a consumer that reads `input` must tolerate both spellings.
 */
const availableCommandsUpdate: SameArm<"available_commands_update"> = false;
const commandInputDiffers: Mutual<
  NonNullable<ArmV1<"available_commands_update">["availableCommands"][number]["input"]>,
  NonNullable<ArmV2<"available_commands_update">["availableCommands"][number]["input"]>
> = false;

// ── The rewritten rows, asserted to genuinely NEED their rewrite ─────────────

/** Rows 1-3, and the whole of §12.4: v1 types `messageId` OPTIONAL, v2 REQUIRES it. */
const agentMessageChunk: SameArm<"agent_message_chunk"> = false;
const userMessageChunk: SameArm<"user_message_chunk"> = false;
const agentThoughtChunk: SameArm<"agent_thought_chunk"> = false;
const v1MessageIdIsOptional: IsOptional<ArmV1<"agent_message_chunk">, "messageId"> = true;
const v2MessageIdIsRequired: IsOptional<ArmV2<"agent_message_chunk">, "messageId"> = false;

/** Row 4: v2 has NO `tool_call` arm at all — which is why the rename is a rename. */
const toolCallGoneFromV2: IsNever<ArmV2<"tool_call">> = true;
const toolCallExistsInV1: IsNever<ArmV1<"tool_call">> = false;

/** Row 11: `current_mode_update` is likewise absent from v2. */
const currentModeGoneFromV2: IsNever<ArmV2<"current_mode_update">> = true;
const currentModeExistsInV1: IsNever<ArmV1<"current_mode_update">> = false;

/** Row 5: `tool_call_update` exists in BOTH, and still differs — v1 requires `title`. */
const toolCallUpdate: SameArm<"tool_call_update"> = false;
const v1ToolCallUpdateTitleIsOptional: IsOptional<ArmV1<"tool_call_update">, "title"> = true;

/**
 * Row 8. NOT for the reason §12.3 gives: SDK 1.4.0's v1 `PlanUpdate` is ALREADY
 * `{plan: PlanUpdateContent}`, exactly like v2's — the two differ one level down, in
 * `PlanUpdateContent`. The `{entries}` body row 8 calls "a v1 agent using the v2 name loosely"
 * is not a v1 shape at all, and an SDK client drops it (see `plan.mjs`'s header).
 */
const planUpdate: SameArm<"plan_update"> = false;
const planContentDiffers: Mutual<ArmV1<"plan_update">["plan"], ArmV2<"plan_update">["plan"]> =
  false;

// ── §7.1: the two events we synthesize are taken VERBATIM from v2 ───────────

type StateArm = ArmV2<"state_update">;
const idleIsV2: Assignable<
  { sessionUpdate: "state_update"; state: "idle"; stopReason: null },
  StateArm
> = true;
const runningIsV2: Assignable<{ sessionUpdate: "state_update"; state: "running" }, StateArm> = true;
/** …and v1 has no `state_update` at all, which is why M0 SYNTHESIZED both of them. */
const stateUpdateAbsentFromV1: IsNever<ArmV1<"state_update">> = true;

export type Checked = [
  typeof sessionInfoUpdate,
  typeof usageUpdate,
  typeof planRemoved,
  typeof compactionUpdate,
  typeof compactionSummaryChunk,
  typeof contentBlockDiffers,
  typeof v1ContentIsV2Content,
  typeof availableCommandsUpdate,
  typeof commandInputDiffers,
  typeof agentMessageChunk,
  typeof userMessageChunk,
  typeof agentThoughtChunk,
  typeof v1MessageIdIsOptional,
  typeof v2MessageIdIsRequired,
  typeof toolCallGoneFromV2,
  typeof toolCallExistsInV1,
  typeof currentModeGoneFromV2,
  typeof currentModeExistsInV1,
  typeof toolCallUpdate,
  typeof v1ToolCallUpdateTitleIsOptional,
  typeof planUpdate,
  typeof planContentDiffers,
  typeof idleIsV2,
  typeof runningIsV2,
  typeof stateUpdateAbsentFromV1,
];
