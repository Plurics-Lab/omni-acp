/**
 * The shared half of the compat suite: the case TYPE, the context every case receives, and the
 * handful of assertions they all reach for.
 *
 * `tests/compat/src/cases.ts` became `cases/` in the M2 Land step (M2-PLAN §1.4), so that six
 * work packages never meet in one file — the same split `daemon/src/http/routes/` already is.
 * Everything below moved here VERBATIM apart from an `export` keyword and two `../` in the import
 * paths; `m1.ts` holds M1's thirteen cases, likewise verbatim, and is FROZEN.
 */
import { readdir } from "node:fs/promises";
import {
  OmniError,
  reduceTurn,
  type DaemonConfig,
  type EventEnvelope,
  type ProbeSummary,
} from "@omni-acp/protocol";
import type { Worker } from "@omni-acp/client";
import { waitGone } from "@omni-acp/testkit";
import type { CompatAgentConfig } from "../config.js";
import {
  acpConversation,
  envelopeFrames,
  openSse,
  parseFrames,
  resolveLaunch,
  tempDir,
  until,
  type CompatHarness,
} from "../harness.js";

/**
 * The acceptance script of `docs/M1-PLAN.md` §4, as named cases — the IDENTICAL script for every
 * configured agent, which is DESIGN §11's M1 criterion made mechanical.
 *
 * A case declares what it NEEDS (`requires`), so an agent that cannot resume skips the resume
 * cases with `source: "capability"` instead of failing them, and the report says so.
 *
 * Owned by M1-WP-F.
 */
export interface CompatCase {
  readonly id: string;
  /** Capabilities this case needs; missing ones become a `capability` skip, never a failure. */
  readonly requires: readonly string[];
  run(ctx: CompatContext): Promise<void>;
}

export interface CompatContext {
  readonly agentId: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly cwd: string;
  /** The whole §4 setup: the daemon, both clients, both tokens, the workspace, the restart. */
  readonly harness: CompatHarness;
  /** Step 0's `ProbeSummary`. It is what turns a missing capability into a sourced skip. */
  readonly probe: ProbeSummary;
  readonly config: CompatAgentConfig;
  /**
   * ONE worker per agent, created lazily and shared by every case that only needs a live one.
   *
   * Cost, and honesty about it: a real agent's cold start is ~7 s and a turn is 3-7 s (corpus
   * finding 15). Thirteen cases each creating their own worker would be thirteen cold starts and
   * thirteen turns' worth of tokens for assertions that do not need a fresh process.
   */
  worker(): Promise<Worker>;
  /**
   * Restart this agent's daemon on the SAME `dataDir` with `overlay` applied to its config, or
   * `null` to drop a previous overlay (review follow-up 2 → `CompatHarness.reconfigure`).
   *
   * The two settings that need it are `webhooks` and `diff`: both are daemon-level, and both have
   * defaults that make an M2 case vacuous rather than failing — `webhooks.enabled:false` with
   * `mode:"allowlist"` and an empty `allow` refuses every delivery, and `diff.provider:"none"`
   * yields `patch: null` forever. Everything else M2 needs is per-worker on `CreateWorkerRequest`
   * or is built-in preset data, so this is the whole daemon-config surface a case may reach.
   *
   * Ruling M2-R16's `denyCidrs: []` belongs in the WEBHOOK CASE'S overlay, not in the harness's
   * base config: a base that disabled the CIDR gate for everyone would turn the compat matrix
   * into the one place the SSRF control is never exercised.
   *
   * It restarts the daemon, so call it BEFORE `worker()`.
   */
  withDaemonConfig(overlay: ((base: DaemonConfig) => DaemonConfig) | null): Promise<void>;
  /** A short prompt, per agent kind — real agents get real English, fixtures get anything. */
  readonly prompts: {
    readonly plain: string;
    readonly read: string;
    readonly write: string;
    readonly remember: string;
    readonly recall: string;
  };
}

export const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};

export function updateKind(e: EventEnvelope): string | null {
  if (e.kind !== "acp.session_update") return null;
  const kind = asRecord(e.payload)["sessionUpdate"];
  return typeof kind === "string" ? kind : null;
}

/** Every envelope of a worker's whole life, read once over HTTP. */
export async function allEnvelopes(
  ctx: CompatContext,
  workerId: string,
  since = 0,
): Promise<EventEnvelope[]> {
  const reader = openSse(ctx.harness.url, ctx.harness.tokenA, workerId, since);
  try {
    // The stream stays open for a live worker, so it is read until it goes quiet rather than
    // until it ends: a `stream_end` only arrives for a CLOSED worker (§8.4).
    await until(() => reader.text().includes("data:"), 10_000, 25);
    let previous = -1;
    while (previous !== reader.text().length) {
      previous = reader.text().length;
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    }
    return envelopeFrames(parseFrames(reader.text())).map(
      (f) => JSON.parse(f.data) as EventEnvelope,
    );
  } finally {
    reader.close();
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new OmniError("internal", message);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The v1-only `sessionUpdate` kinds. None may survive at `payloadVersion: 2` — that is exactly
 * what the field MEANS after ruling M1-R10, and it is the wire-visible half of §12.7's
 * "no `tool_call` / `plan` / `current_mode_update` survives".
 */
export const V1_ONLY_KINDS = new Set(["tool_call", "plan", "current_mode_update"]);
