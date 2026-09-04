import type { OutboundCall, RuntimeDescriptor } from "@omni-acp/protocol";
import { arr, has, record, str } from "./json.js";

/**
 * A canonical (v2) client→agent call → the spelling THIS runtime answers (CONTRACTS.md §12.3
 * rows 19–28, §17.3).
 *
 * PREFERENCE ORDER OVER SPELLINGS, not one name per capability. F18 is decisive: on ONE
 * claude-acp process `session/set_mode` and `session/set_config_option` are both live while
 * `session/set_model` — which multica saw on 8 runtimes — is `-32601`. A registry that maps one
 * capability to one method name cannot express that.
 *
 * The first spelling not already known-unsupported wins; a `-32601` marks one unsupported for
 * the life of the process and is NEVER persisted, because a version bump may add it back. The
 * `unsupported` set is passed in rather than held here, so this function stays pure.
 *
 * `onFailure` is the capability's, verbatim: `setConfig` is `fail` (a caller asked for a model
 * and did not get one) and `setOptions` is `warn` (a vendor extension we offered to pass through,
 * which the agent has done nothing wrong by not implementing) — DESIGN §6.2, review R2.
 *
 * Owned by M1-WP-B.
 */

/** Canonical (v2) method → the descriptor capability whose spellings answer it. */
const CAPABILITY_OF: Readonly<Record<string, string>> = {
  "session/resume": "resume",
  "session/set_config_option": "setConfig",
  "session/set_options": "setOptions",
  "session/list": "list",
  "session/close": "close",
  // Row 23, marked `unverified`: claude-acp advertises `auth: {logout:{}}` and `authMethods: []`
  // and the corpus never exercises it. With no `prefer` entry the spelling resolves to `null`,
  // which is how a capability nobody has proven reports itself — and it is what lets an operator
  // add `authLogin: {spellings:[…]}` to a descriptor without a code change.
  "auth/login": "authLogin",
  "auth/logout": "authLogout",
};

/**
 * Renames a canonical call's params for one concrete spelling.
 *
 * Keyed by `<canonical> <spelling>` — the pair, not the spelling alone, because the same wire
 * method can be the answer to two different canonical calls on different runtimes. A pair with
 * no entry passes its params through, which is what row 26b's vendor extension needs.
 */
const PARAM_RULES: Readonly<
  Record<string, (p: Record<string, unknown>) => Record<string, unknown>>
> = {
  // Row 24: v1's `session/load` has no `replayFrom`. Sending it is harmless on claude-acp
  // (it "accepts and ignores" it, F18) but it is not in v1's schema, and an agent that
  // validates its params would reject the whole call over a field we invented for it.
  "session/resume session/load": ({ replayFrom: _replayFrom, ...rest }) => rest,
  // Row 25: `{configId, value}` → `{modeId}`. `session/set_mode` is still live on the same
  // process that answers `session/set_config_option` (F18), so this is a real fallback and
  // not a legacy branch.
  "session/set_config_option session/set_mode": (p) => ({ modeId: p["value"] }),
  // Row 26: the vendor spelling multica saw on 8 runtimes. `-32601` on claude-acp, which is
  // exactly why it is a SPELLING behind a preference order rather than a method we call.
  "session/set_config_option session/set_model": (p) => ({ modelId: p["value"] }),
};

export function mapRequest(
  method: string,
  params: Record<string, unknown>,
  descriptor: RuntimeDescriptor,
  unsupported: ReadonlySet<string>,
): OutboundCall {
  const canonical = normalizeParams(method, params, descriptor);

  const capability = CAPABILITY_OF[method];
  if (capability === undefined) {
    // Not a capability with spellings — `initialize`, `session/new`, `session/prompt`,
    // `session/cancel`. One name, and its params are renamed above.
    return { method, params: canonical, spelling: method, onFailure: "fail" };
  }

  const preference = descriptor.prefer[capability];
  const spellings = preference?.spellings ?? [];
  const onFailure = preference?.onFailure ?? "fail";
  const spelling = spellings.find((s) => !unsupported.has(s)) ?? null;

  if (spelling === null) {
    // Row 28: every spelling exhausted (or none declared). The caller reports `unsupported`
    // rather than guessing a method name — a guessed spelling earns a `-32601` at best and
    // silently does the wrong thing at worst.
    return { method, params: canonical, spelling: null, onFailure };
  }

  const rename = PARAM_RULES[`${method} ${spelling}`];
  return {
    method: spelling,
    params: rename === undefined ? canonical : rename(canonical),
    spelling,
    onFailure,
  };
}

/** Canonical-side rewrites that apply to every spelling of a call. */
function normalizeParams(
  method: string,
  params: Record<string, unknown>,
  descriptor: RuntimeDescriptor,
): Record<string, unknown> {
  let out = untagIds(params) as Record<string, unknown>;

  if (method === "initialize") {
    // Row 19: v2's `{protocolVersion, capabilities, info}` is spelled
    // `{protocolVersion, clientCapabilities, clientInfo}` on the v1 wire. v2's
    // `ClientCapabilities` has no `fs`/`terminal` keys at all, which is exactly D3's `{}`.
    out = renameKeys(out, { capabilities: "clientCapabilities", info: "clientInfo" });
  }

  if (method === "session/set_config_option") {
    // F17: the param is named `configId` here and `optionId` on a runtime that spells it that
    // way — learned from `-32602 data.<field>._errors`, never guessed, and carried as a quirk.
    const field = descriptor.quirks.configIdField;
    if (field !== "configId" && has(out, "configId")) {
      out = renameKeys(out, { configId: field });
    }
  }

  // Row 22: an `McpServer` without a `type` gets one — `command` ⇒ stdio, `url` ⇒ http.
  // UNREACHABLE from the wire in M1 (`mcpServers` is always `[]`, DESIGN §8) and implemented
  // anyway, because M2's presets are the highest-risk attack surface in the design and a rule
  // written then would be a rule written under pressure.
  const servers = arr(out["mcpServers"]);
  if (servers !== null) out = { ...out, mcpServers: servers.map(typedMcpServer) };

  return out;
}

function renameKeys(
  params: Record<string, unknown>,
  renames: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params)) out[renames[key] ?? key] = params[key];
  return out;
}

function typedMcpServer(raw: unknown): unknown {
  const server = record(raw);
  if (server === null || str(server["type"]) !== null) return raw;
  if (str(server["command"]) !== null) return { ...server, type: "stdio" };
  if (str(server["url"]) !== null) return { ...server, type: "http" };
  // Neither shape: forwarded untouched. Inventing a transport for a server we cannot classify
  // is how a `stdio` command ends up being launched as one (DESIGN §8).
  return raw;
}

/**
 * Row 27: v2's tagged `{type:"id", value}` → v1's untagged `{value}`, recursively.
 *
 * The tag is DROPPED rather than the object flattened: v1's untagged arm is `{value}` and
 * claude-acp accepts it. Applied through arrays and nested objects because the tag can appear
 * anywhere a v2 id can, and applied only to that exact two-key shape so a vendor object that
 * happens to carry a `type` is untouched.
 */
export function untagIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(untagIds);
  const o = record(value);
  if (o === null) return value;
  const keys = Object.keys(o);
  if (o["type"] === "id" && has(o, "value") && keys.length === 2) return { value: o["value"] };
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = untagIds(o[key]);
  return out;
}

/**
 * Row 18b: an agent→client METHOD in `descriptor.inboundAliases` is renamed before the update
 * table runs.
 *
 * Only REGISTERED spellings are aliased. An unregistered agent→client method keeps §7.6's
 * `-32601`, so a typo can never silently swallow updates — which is the whole reason this is a
 * lookup and not a fuzzy match. `{}` for every agent M1 knows about (DESIGN §1.3, review R4).
 */
export function resolveInboundMethod(method: string, descriptor: RuntimeDescriptor): string {
  return descriptor.inboundAliases[method] ?? method;
}
