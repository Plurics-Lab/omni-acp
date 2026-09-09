import type { McpResolution, McpServerPreset, TurnWarning } from "@omni-acp/protocol";

/**
 * `mcpCapabilities` filtering — and the one rule that is easy to get backwards.
 *
 * **stdio is NEVER filtered.** v1 has no stdio bit at all, and codex advertises
 * `{acp:false, http:true, sse:false}` while happily taking stdio servers. Filtering on the absent
 * bit would drop every stdio preset from the agent that uses them most.
 *
 * Whether an ABSENT capability block means "everything" or "nothing" is decided from the
 * DESCRIPTOR (`toleratesOmittedMcpCapabilities`), never from an agent-id branch —
 * `descriptor-is-the-only-branch` is the guard.
 *
 * An unusable `http` preset is NOT an error: it lands as `applied:[] / dropped:[{name, reason}]`
 * on the snapshot plus a `TurnWarning`, because a capability the client did not get is something
 * to report, not something to fail a worker over.
 *
 * Owned by M2-B-WP-S.
 */

/** The three transport bits v1 and v2 both spell the same way inside the block. */
const BITS = ["http", "sse", "acp"] as const;

/**
 * The `TurnWarning.source` a dropped preset carries.
 *
 * `TurnWarning["source"]` is a CLOSED union declared in `packages/protocol/src/turn.ts`, which
 * M2 widened for `patch` and `watchdog` and not for MCP. `"policy"` is the only member that
 * means "the daemon itself refused to pass something through", which is precisely what a
 * capability filter does; the specificity lives in `code`, where a consumer can switch on it.
 * A dedicated `"mcp"` source is a one-word change to a file this work package does not own —
 * recorded in M2-B-WP-S's notes rather than made here.
 */
const WARNING_SOURCE: TurnWarning["source"] = "policy";

/** Stable across every dropped preset, so a client can match on it instead of on prose. */
const WARNING_CODE = "mcp_preset_dropped";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Finds the `mcpCapabilities` block, wherever this agent put it.
 *
 * The signature says `caps` is the block, and a caller that passes the block gets the block back
 * (rule 3). The other two rules exist because the ONE object a worker actually holds is
 * `AgentCapabilitiesSnapshot.raw` — the verbatim `agentCapabilities` — and v1 and v2 disagree
 * about where inside it the block lives (§12.3 row 20: `loadSession` / `promptCapabilities` /
 * `mcpCapabilities` all move under `session` in v2). Reading both spellings here is the same
 * per-field idempotent mapping `mapCapabilities` already does, and it keeps the daemon from
 * having to know a wire shape.
 *
 * Returns `null` for "this agent declared no block", which is the case
 * `toleratesOmittedMcpCapabilities` decides — and which is NOT the same as an empty block
 * `{}`. An empty block is an agent that answered the question with "none of them".
 */
export function readMcpCapabilityBlock(
  caps: Readonly<Record<string, unknown>> | null,
): Readonly<Record<string, unknown>> | null {
  if (caps === null) return null;
  // 1. v1, and both real agents: `agentCapabilities.mcpCapabilities`.
  const v1 = Object.hasOwn(caps, "mcpCapabilities") ? caps["mcpCapabilities"] : undefined;
  if (isRecord(v1)) return v1;
  // 2. v2: `capabilities.session.mcp`.
  const session = Object.hasOwn(caps, "session") ? caps["session"] : undefined;
  if (isRecord(session)) {
    const v2 = Object.hasOwn(session, "mcp") ? session["mcp"] : undefined;
    if (isRecord(v2)) return v2;
  }
  // 3. The block itself, which is what the signature documents. Recognised by carrying at least
  //    one of the three bits — an object with none of them is indistinguishable from a
  //    capabilities envelope that simply has no MCP block, and "absent" is the fail-closed
  //    reading of that ambiguity.
  if (BITS.some((bit) => Object.hasOwn(caps, bit))) return caps;
  return null;
}

/**
 * `null` ⇒ this transport may be used. A string ⇒ the reason it may not, in OUR words.
 *
 * The reasons are ours and never the agent's: `no-agent-prose` is about DECIDING on prose, and
 * the way a reason becomes a decision input is by being the only string anybody has to match on.
 */
function refuse(
  type: McpServerPreset["type"],
  block: Readonly<Record<string, unknown>> | null,
  tolerateOmitted: boolean,
): string | null {
  // stdio is the baseline and is NEVER filtered. v1 has no `mcpCapabilities.stdio` bit to
  // consult, and codex-acp advertises `{acp:false, http:true, sse:false}` while taking stdio
  // servers without complaint (§23.2). A filter that required a bit here would drop every stdio
  // preset from the agent that uses them most — the exact backwards reading this comment exists
  // to prevent.
  if (type === "stdio") return null;

  if (block === null) {
    // Decided FROM THE DESCRIPTOR (§17.1). `toleratesOmittedMcpCapabilities` is a quirk row, so
    // an operator teaches the daemon about a new runtime by editing a descriptor, and
    // `descriptor-is-the-only-branch` stays true.
    return tolerateOmitted
      ? null
      : `the agent declared no mcpCapabilities block and its descriptor does not tolerate the omission`;
  }

  return block[type] === true ? null : `the agent does not advertise mcpCapabilities.${type}`;
}

/** `{K: V}` → ACP's `[{name, value}]`, key-sorted so two equal maps produce equal wire bytes. */
function pairs(map: Readonly<Record<string, string>>): { name: string; value: string }[] {
  return Object.keys(map)
    .sort()
    .map((name) => ({ name, value: map[name] as string }));
}

/**
 * One resolved preset → the ACP `McpServer` that goes into `session/new`.
 *
 * **stdio is emitted UNTAGGED, on purpose.** ACP v1's `McpServer` is an `anyOf` whose stdio arm
 * is the untagged one (`{name, command, args, env}` — no `type` at all) while `http` and `sse`
 * REQUIRE their tag; v2 tags all four. Emitting v1's shape is what both real agents accept, and
 * it is also what makes §12.3 row 22 — "an `McpServer` without a `type` gets one: `command` ⇒
 * stdio, `url` ⇒ http" — a rule with something to do. Tagging stdio here would leave row 22
 * implemented and forever unexercised, which is the state M1 shipped in and M2 is supposed to
 * end.
 *
 * `env` and `headers` are ARRAYS of `{name, value}` on the wire and RECORDS in config; that
 * asymmetry is the schema's, not ours.
 */
function toWire(name: string, server: McpServerPreset): Readonly<Record<string, unknown>> {
  if (server.type === "stdio") {
    return {
      name,
      command: server.command ?? "",
      args: [...server.args],
      env: pairs(server.env),
    };
  }
  return {
    type: server.type,
    name,
    url: server.url ?? "",
    headers: pairs(server.headers),
  };
}

export function filterMcpCapabilities(o: {
  presets: readonly { name: string; server: McpServerPreset }[];
  caps: Readonly<Record<string, unknown>> | null;
  tolerateOmitted: boolean;
}): McpResolution {
  const block = readMcpCapabilityBlock(o.caps);

  const servers: Readonly<Record<string, unknown>>[] = [];
  const applied: string[] = [];
  const dropped: { name: string; reason: string }[] = [];
  const warnings: TurnWarning[] = [];

  for (const { name, server } of o.presets) {
    const reason = refuse(server.type, block, o.tolerateOmitted);
    if (reason !== null) {
      // Reported, never silent, and never an ERROR: DESIGN §6.2 says filter, and a capability
      // the client did not get is something to say out loud rather than something to fail a
      // worker over. The snapshot row and the warning carry the SAME `{name, reason}` so an
      // operator reading a turn and an operator reading `GET /v1/workers/{wid}` see one story.
      dropped.push({ name, reason });
      warnings.push({
        code: WARNING_CODE,
        message: `mcp preset ${JSON.stringify(name)} was dropped: ${reason}`,
        source: WARNING_SOURCE,
        detail: { name, reason, type: server.type },
      });
      continue;
    }
    servers.push(toWire(name, server));
    applied.push(name);
  }

  return { servers, applied, dropped, warnings };
}
