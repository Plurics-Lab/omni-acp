import type {
  AgentCapabilitiesSnapshot,
  PromptCapabilities,
  ResumeMethod,
  RuntimeDescriptor,
} from "@omni-acp/protocol";
import { has, record, str, type Json } from "./json.js";

/**
 * The `initialize` / `session/new` responses → `AgentCapabilitiesSnapshot` (CONTRACTS.md §12.3
 * rows 20–21, §5.3).
 *
 * Mapped PER FIELD and IDEMPOTENTLY on fields that are already v2 (F24): claude-acp answers
 * `protocolVersion: 1` and returns `agentCapabilities` with `loadSession` at the top level,
 * while a v2 agent returns `capabilities.session.load`. Both are read, v2 first, and neither is
 * a version switch.
 *
 * Two things this resolves ONCE, at the handshake, because resolving them later means resolving
 * them differently on different code paths:
 *
 *  - `resume.method`, from the descriptor's PREFERENCE ORDER intersected with what the agent
 *    actually advertised (F18: `session/resume` and `session/load` are both live here). `null`
 *    means this worker can never hibernate — ruling M1-R15 keeps the process rather than
 *    creating a guaranteed `422` on a timer.
 *  - `modes` and `configOptions` off the `session/new` body — and off the `session/load` /
 *    `session/resume` body too, which returns one contrary to the v1 schema (F18, quirk
 *    `loadReturnsBody`). Row 11's `current_mode_update → config_option_update` cannot be built
 *    without the mode catalogue, and re-deriving it per update would make the map stateful.
 *
 * Owned by M1-WP-B (the map) and consumed by M1-WP-C's `handshake.ts`.
 */
export function mapCapabilities(
  initialize: unknown,
  sessionBody: unknown,
  descriptor: RuntimeDescriptor,
): AgentCapabilitiesSnapshot {
  const init = record(initialize) ?? {};
  // Row 20, inbound rename: v2 `{capabilities, info}` ← v1 `{agentCapabilities, agentInfo}`.
  const caps = record(init["capabilities"]) ?? record(init["agentCapabilities"]) ?? {};
  // …and `loadSession` / `promptCapabilities` / `mcpCapabilities` move under `session` in v2.
  const session = record(caps["session"]) ?? {};
  const sessionCaps = record(caps["sessionCapabilities"]) ?? {};

  const body = record(sessionBody);
  const protocolVersion = init["protocolVersion"] === 2 ? 2 : 1;

  const loadSession = flag(session["load"]) || flag(caps["loadSession"]);
  const supportsSessionClose = flag(session["close"]) || flag(sessionCaps["close"]);
  const supportsSessionList = flag(session["list"]) || flag(sessionCaps["list"]);
  const supportsResume = flag(session["resume"]) || flag(sessionCaps["resume"]);

  return {
    protocolVersion,
    // Verbatim, never reshaped, never cached — a snapshot of what the agent said about itself.
    raw: caps,
    loadSession,
    promptCapabilities: mapPromptCapabilities(
      record(session["prompt"]) ?? record(caps["promptCapabilities"]),
    ),
    supportsSessionClose,
    resume: resolveResume(descriptor, { loadSession, supportsResume }),
    supportsSessionList,
    configOptions: readList(body, "configOptions"),
    modes: body === null ? null : record(body["modes"]),
    extensions: liveExtensions(descriptor, { supportsSessionList, supportsSessionClose }),
  };
}

/**
 * Row 21: `promptCapabilities: {image: true}` → `{image: {}}`.
 *
 * v1 spells each capability as a BOOLEAN and v2 as an OBJECT (so a capability can grow fields
 * without a breaking change). `true` → `{}`; `false` or absent → OMITTED, because an empty
 * object is "supported, no options" and there is no v2 spelling for "explicitly unsupported".
 * A value that is already an object is kept BY IDENTITY, which is what makes this idempotent.
 */
function mapPromptCapabilities(raw: Json | null): PromptCapabilities | null {
  if (raw === null) return null;
  const out: Record<string, unknown> = {};
  for (const key of ["image", "audio", "embeddedContext"]) {
    if (!has(raw, key)) continue;
    const value = raw[key];
    if (value === true) out[key] = {};
    else if (record(value) !== null) out[key] = value;
    // `false` and every other value: omitted.
  }
  return out as PromptCapabilities;
}

/**
 * The descriptor's preference order, intersected with what the agent advertised.
 *
 * A spelling the descriptor lists but the agent did not advertise is NOT chosen: `session/load`
 * requires `loadSession`, `session/resume` requires `sessionCapabilities.resume`. An agent that
 * advertised neither gets `method: null` and can never hibernate, which is the honest answer and
 * the one M1-R15 wants — hibernating a worker you cannot wake is a one-way door.
 */
function resolveResume(
  descriptor: RuntimeDescriptor,
  advertised: { loadSession: boolean; supportsResume: boolean },
): AgentCapabilitiesSnapshot["resume"] {
  const spellings = descriptor.prefer["resume"]?.spellings ?? [];
  let method: ResumeMethod | null = null;
  for (const spelling of spellings) {
    // `handshake.ts` narrows against `ResumeMethod` and drops a spelling it does not recognise
    // rather than sending it blind (§5.1 `runtime.ts`); the same narrowing is done here so the
    // snapshot can never name a method nobody will send.
    if (spelling === "session/resume" && advertised.supportsResume) {
      method = "session/resume";
      break;
    }
    if (spelling === "session/load" && advertised.loadSession) {
      method = "session/load";
      break;
    }
  }
  return {
    method,
    // v1's `session/load` has no `replayFrom` at all; only the v2 spelling can carry one.
    replayFrom: method === "session/resume",
    // From the DESCRIPTOR: F15's mismatched-cwd refusal appears in no committed transcript, so
    // it is a recorded quirk and a compat case, never something inferred from a live response.
    requiresSameCwd: descriptor.quirks.resumeRequiresSameCwd,
  };
}

/** Method names the descriptor prefers AND the agent advertised — "proven live", not hoped for. */
function liveExtensions(
  descriptor: RuntimeDescriptor,
  advertised: { supportsSessionList: boolean; supportsSessionClose: boolean },
): readonly string[] {
  const out: string[] = [];
  if (advertised.supportsSessionList) out.push(...(descriptor.prefer["list"]?.spellings ?? []));
  if (advertised.supportsSessionClose) out.push(...(descriptor.prefer["close"]?.spellings ?? []));
  return out;
}

function readList(body: Json | null, key: string): readonly unknown[] | null {
  if (body === null) return null;
  const value = body[key];
  return Array.isArray(value) ? (value as readonly unknown[]) : null;
}

/** v1 spells a capability `true`; v2 spells it `{}`. Both are "yes"; everything else is "no". */
function flag(value: unknown): boolean {
  return value === true || record(value) !== null;
}

/** `session/new`'s `sessionId`, wherever the runtime put it. Used by the handshake and the probe. */
export function sessionIdOf(body: unknown): string | null {
  const b = record(body);
  return b === null ? null : str(b["sessionId"]);
}
