import { OmniError } from "@omni-acp/protocol";
import type { McpServerPreset, ResolvedDaemonConfig } from "@omni-acp/protocol";

/**
 * Preset NAMES → resolved server objects. The one place a client's `mcp: string[]` becomes a
 * command line, and it reads that command line from CONFIG and from nowhere else (DESIGN §8's
 * 🔴).
 *
 * An unknown name is `400` NAMING it; a name outside the token's `mcpPresets` allowlist is `403`.
 * Never a silent drop: a client that believes a tool is available and is not will spend a whole
 * turn discovering it, and the agent will explain the failure in prose we are forbidden to parse.
 *
 * Owned by M2-B-WP-S.
 */

/** One resolved row. Exported as a TYPE only — the barrel exports the function, not this name. */
export interface ResolvedMcpPreset {
  readonly name: string;
  readonly server: McpServerPreset;
}

/**
 * A preset name in an error message is a value that came from the wire, so it is quoted and
 * clamped the way `ids.ts` clamps everything else it echoes. `CreateWorkerRequest.mcp` already
 * caps a name at 64 characters; an in-process caller is not bound by that schema, and this is
 * the boundary that does not care which caller it got.
 */
const MAX_NAME_IN_MESSAGE = 64;

function quoted(name: string): string {
  const clamped =
    name.length <= MAX_NAME_IN_MESSAGE ? name : `${name.slice(0, MAX_NAME_IN_MESSAGE)}…`;
  return JSON.stringify(clamped);
}

/**
 * A deep-enough copy that a resolved server can never alias `DaemonConfig.mcpServers`.
 *
 * The resolved objects travel into a `SessionStrategy` and from there onto the wire; a caller
 * that mutated one would be mutating the operator's config for every worker created afterwards.
 * `args` / `headers` / `env` are the three mutable members, and each is copied by value.
 */
function copyPreset(preset: McpServerPreset): McpServerPreset {
  return {
    type: preset.type,
    ...(preset.command === undefined ? {} : { command: preset.command }),
    args: [...preset.args],
    ...(preset.url === undefined ? {} : { url: preset.url }),
    headers: { ...preset.headers },
    env: { ...preset.env },
  };
}

/**
 * An operator's preset that cannot be launched at all.
 *
 * `McpServerPreset` gives `type` a zod DEFAULT of `"stdio"`, so `{url: "https://…"}` with no
 * `type` parses as a stdio server with no command — a config trap whose only symptom would be a
 * spawn failure minutes later, inside the agent, reported in prose. §12.3 row 22's INFERENCE
 * (`command` ⇒ stdio, `url` ⇒ http) is deliberately NOT applied here to paper over it: after
 * zod's default there is no way to tell "the operator omitted `type`" from "the operator wrote
 * `stdio`", and guessing between those two is how a preset silently becomes a different server
 * than the one that was reviewed. Row 22 stays where it is — in the normalizer, on the wire
 * shape this module emits (see `capabilities.ts`).
 *
 * `internal` and not `bad_request`: the CLIENT named a preset that exists and is allowed. The
 * defect is in the operator's config, and a 400 would tell the client to fix something it cannot
 * see.
 */
function assertLaunchable(name: string, preset: McpServerPreset): void {
  const bad = (why: string): never => {
    throw new OmniError("internal", `mcp preset ${quoted(name)} is misconfigured: ${why}`, {
      // The COMMAND is never in a message or a detail — DESIGN §8 §5.1's `redactArgs` rule
      // applies to an MCP command exactly as it applies to an agent's.
      detail: { preset: name, type: preset.type },
    });
  };
  if (preset.type === "stdio") {
    if (preset.command === undefined) bad('type "stdio" requires a command');
    if (preset.url !== undefined) bad('type "stdio" does not take a url');
    return;
  }
  if (preset.url === undefined) bad(`type ${JSON.stringify(preset.type)} requires a url`);
  if (preset.command !== undefined) {
    bad(`type ${JSON.stringify(preset.type)} does not take a command`);
  }
}

export function resolveMcpPresets(
  names: readonly string[],
  cfg: ResolvedDaemonConfig,
  allow: readonly string[] | "*",
): readonly ResolvedMcpPreset[] {
  const resolved: ResolvedMcpPreset[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    // Naming the same preset twice asks for the same server twice. It is not an error — the
    // client got exactly what it named — but handing the agent two identical stdio entries would
    // start the process twice, so the SECOND mention resolves to nothing. First occurrence wins,
    // and the request order is preserved, because `mcpServers` order is the agent's tool
    // precedence on several runtimes.
    if (seen.has(name)) continue;
    seen.add(name);

    // THE ALLOWLIST IS CHECKED FIRST, and the order is the security argument.
    //
    // `403` for a disallowed name and `400` for an unknown one is exactly the split a client
    // needs — and, checked the other way round, it is also an oracle: a token allowed NOTHING
    // (the default, `[]`) could enumerate the operator's whole preset table by watching which
    // names answer 400 and which answer 403. Asking the ACL first makes every name a token may
    // not have answer identically, so the reply says nothing about the config.
    if (allow !== "*" && !allow.includes(name)) {
      throw new OmniError("forbidden", `mcp preset ${quoted(name)} is not allowed for this token`, {
        detail: { preset: name },
      });
    }

    // `Object.hasOwn`, not `in` and not a bare read: `mcpServers` is a plain record built by
    // zod, and `cfg.mcpServers["constructor"]` is a truthy value on every object in JavaScript.
    const preset = Object.hasOwn(cfg.mcpServers, name) ? cfg.mcpServers[name] : undefined;
    if (preset === undefined) {
      // NAMING it, never a silent drop (§23.1): a client that believes a tool is available and
      // is not will spend a whole turn discovering it, and the agent will explain the failure in
      // prose `no-agent-prose` forbids us from reading.
      throw new OmniError("bad_request", `unknown mcp preset ${quoted(name)}`, {
        detail: { preset: name },
      });
    }

    assertLaunchable(name, preset);
    resolved.push({ name, server: copyPreset(preset) });
  }

  return resolved;
}
