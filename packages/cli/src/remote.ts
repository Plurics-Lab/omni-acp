import { OmniError, type AgentListResponse, type ProbeResponse } from "@omni-acp/protocol";
import type { WorkerListResponse, WorkerSnapshot } from "@omni-acp/protocol";

/**
 * The three READ-ONLY commands M1 adds: `omni-acp agents`, `omni-acp workers`, `omni-acp probe`
 * (CONTRACTS.md §5.7).
 *
 * They talk to a daemon over ordinary loopback HTTP with the global `fetch`, and NOT through
 * `@omni-acp/client`: §3.1's DAG runs `protocol → core → daemon → cli`, and the client is a
 * sibling leaf. Adding it as a dependency to save thirty lines would put a second package in the
 * CLI's runtime closure to make three GETs — and `dependency-direction` would fail the build,
 * correctly. What the SDK gives a caller (reconnecting streams, the turn reducer, the lease
 * fence) is exactly what a one-shot read-only command does not need.
 *
 * Owned by M1-WP-F.
 */

export interface RemoteTarget {
  readonly url: string;
  readonly token: string;
}

/** The daemon to talk to: flags first, then the environment, then a message naming both. */
export function targetOf(
  args: { url?: string; token?: string },
  env: NodeJS.ProcessEnv,
  command: string,
): RemoteTarget {
  const url = args.url ?? env["OMNI_ACP_URL"] ?? "";
  const token = args.token ?? env["OMNI_ACP_TOKEN"] ?? "";
  if (url.trim() === "") {
    throw new OmniError(
      "bad_request",
      `${command} needs the daemon's url: pass --url or set OMNI_ACP_URL`,
    );
  }
  if (token === "") {
    throw new OmniError(
      "bad_request",
      `${command} needs a token: pass --token or set OMNI_ACP_TOKEN`,
    );
  }
  return { url: url.replace(/\/+$/, ""), token };
}

/**
 * One request, with the daemon's own error body preserved.
 *
 * The token travels in `Authorization` and NEVER in the URL, for the same reason the SDK does it
 * that way: a query parameter ends up in every proxy log (§8.4). And an error body is read for
 * its `message` rather than reported as "HTTP 403", because the daemon already wrote the sentence
 * an operator needs.
 */
async function call<R>(
  target: RemoteTarget,
  method: string,
  path: string,
  body?: unknown,
): Promise<R> {
  const response = await fetch(`${target.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${target.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).catch((e: unknown) => {
    throw new OmniError("internal", `cannot reach ${target.url}: ${describe(e)}`, { cause: e });
  });

  const text = await response.text();
  if (!response.ok) {
    const message = messageOf(text) ?? `HTTP ${String(response.status)}`;
    throw new OmniError("bad_request", message, { detail: { status: response.status } });
  }
  try {
    return JSON.parse(text) as R;
  } catch (e) {
    throw new OmniError("internal", `${method} ${path} returned a body that is not JSON`, {
      cause: e,
    });
  }
}

function messageOf(text: string): string | null {
  try {
    const body = JSON.parse(text) as { message?: unknown };
    return typeof body.message === "string" ? body.message : null;
  } catch {
    return text.trim() === "" ? null : text.slice(0, 512);
  }
}

function describe(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(e);
}

export function listAgents(target: RemoteTarget): Promise<AgentListResponse> {
  return call<AgentListResponse>(target, "GET", "/v1/agents");
}

export function listWorkers(target: RemoteTarget): Promise<WorkerListResponse> {
  return call<WorkerListResponse>(target, "GET", "/v1/workers");
}

export function probeAgentAt(
  target: RemoteTarget,
  agentId: string,
  o: { deep?: boolean; force?: boolean },
): Promise<ProbeResponse> {
  return call<ProbeResponse>(target, "POST", `/v1/agents/${encodeURIComponent(agentId)}/probe`, {
    ...(o.deep === true ? { deep: true } : {}),
    ...(o.force === true ? { force: true } : {}),
  });
}

// ── rendering ────────────────────────────────────────────────────────────────
//
// Plain columns, padded from the widest cell, because the alternative is a table library in the
// runtime closure of a command that prints five rows. `--json` is there for anything that wants
// to be parsed; this half is for a person.

export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length), 0),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

export function renderAgents(body: AgentListResponse): string {
  if (body.agents.length === 0) return "no agents configured";
  return renderTable(
    ["ID", "COMMAND", "RUNTIME", "PROBED"],
    body.agents.map((a) => [
      a.id,
      // `args` are already redacted by the daemon (`redactArgs`), and printing them back is how a
      // credential-shaped flag would reach a terminal scrollback. The command alone is enough to
      // recognise an agent.
      a.command,
      a.runtimeId,
      a.probed === null ? "never" : a.probed.at,
    ]),
  );
}

export function renderWorkers(
  workers: readonly WorkerSnapshot[],
  o: { includeClosed?: boolean },
): string {
  const shown = o.includeClosed === true ? workers : workers.filter((w) => w.state !== "closed");
  if (shown.length === 0) {
    return o.includeClosed === true ? "no workers" : "no live workers (use --include-closed)";
  }
  return renderTable(
    ["ID", "AGENT", "STATE", "PID", "GEN", "LEASE", "CWD"],
    shown.map((w) => [
      w.workerId,
      w.agentId,
      w.state,
      // A hibernated worker owns no process, and saying "-" is the honest rendering of the `null`
      // §15.2 puts there — never a stale pid from before the tree was reclaimed.
      w.process === null ? "-" : String(w.process.pid),
      String(w.generation),
      w.lease.holder === null ? "-" : (w.lease.holder.clientId ?? w.lease.holder.tokenId),
      w.cwd,
    ]),
  );
}

/** `agentInfo` is the agent's own object, forwarded verbatim — read for display, never reshaped. */
function agentInfoOf(info: Readonly<Record<string, unknown>> | null): string {
  if (info === null) return "-";
  const name = typeof info["name"] === "string" ? info["name"] : "?";
  const version = typeof info["version"] === "string" ? info["version"] : "";
  return `${name} ${version}`.trim();
}

export function renderProbe(body: ProbeResponse): string {
  const p = body.probe;
  const timings = Object.entries(p.timings);
  const lines = [
    `agent          ${p.agentId}`,
    `fingerprint    ${p.descriptorFingerprint}`,
    `agentInfo      ${agentInfoOf(p.agentInfo)}`,
    `protocol       ${String(p.protocolVersion)}`,
    `resume         ${p.resumeMethod ?? "none"}`,
    `cached         ${String(body.cached)}`,
    `probed at      ${p.at}`,
    `supported      ${p.supportedMethods.length === 0 ? "-" : p.supportedMethods.join(", ")}`,
    // The rows that become the compat suite's `capability` skips: a method this runtime answered
    // `-32601` is a case nobody should assert (§18.3).
    `unsupported    ${p.unsupportedMethods.length === 0 ? "-" : p.unsupportedMethods.join(", ")}`,
  ];
  const learned = Object.entries(p.learnedParams);
  if (learned.length > 0) {
    // F17: `-32602 data.<field>._errors` is how the probe learns a param is `configId` and not
    // `optionId`. Printing it is what turns that from a log line into an operator's answer.
    lines.push(`learned params ${learned.map(([k, v]) => `${k}=${v}`).join(", ")}`);
  }
  if (timings.length > 0) {
    lines.push(
      "",
      renderTable(
        ["STEP", "MS"],
        timings.map(([step, ms]) => [step, String(ms)]),
      ),
    );
  }
  return lines.join("\n");
}
