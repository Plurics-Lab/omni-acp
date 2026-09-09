import { OmniError, type AgentListResponse, type ProbeResponse } from "@omni-acp/protocol";
import type {
  DeliveryListResponse,
  DeliveryRecord,
  InteractionAnswerResult,
  InteractionListResponse,
  RunListResponse,
  SetConfigResponse,
  WorkerListResponse,
  WorkerSnapshot,
} from "@omni-acp/protocol";

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
    ["ID", "AGENT", "STATE", "PID", "GEN", "LEASE", "PENDING", "CWD"],
    shown.map((w) => [
      w.workerId,
      w.agentId,
      // M2: `requires_action` is a real state now that a park has somewhere to park (§19.5), and
      // it is the one an operator has to ACT on — so the pending count sits beside it. The
      // invariant is visible in the two columns: non-empty pending ⟺ `requires_action`.
      w.state,
      // A hibernated worker owns no process, and saying "-" is the honest rendering of the `null`
      // §15.2 puts there — never a stale pid from before the tree was reclaimed.
      w.process === null ? "-" : String(w.process.pid),
      String(w.generation),
      w.lease.holder === null ? "-" : (w.lease.holder.clientId ?? w.lease.holder.tokenId),
      String((w.interactions ?? []).length),
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

// ── M2's four commands (CONTRACTS.md §5.8.10) ────────────────────────────────
//
// Same three moves as M1's: resolve the target, make ONE call, print. Nothing here orchestrates
// — `interactions answer` is one POST and not a get-then-decide, because the daemon re-checks
// D4's rules on the answer it receives and a CLI that pre-selected an option would be a second
// place those rules live (§19.7).

export function listInteractions(
  target: RemoteTarget,
  workerId: string,
): Promise<InteractionListResponse> {
  return call<InteractionListResponse>(
    target,
    "GET",
    `/v1/workers/${encodeURIComponent(workerId)}/interactions`,
  );
}

export function answerInteraction(
  target: RemoteTarget,
  workerId: string,
  reqId: string,
  body: unknown,
): Promise<InteractionAnswerResult> {
  return call<InteractionAnswerResult>(
    target,
    "POST",
    `/v1/workers/${encodeURIComponent(workerId)}/interactions/${encodeURIComponent(reqId)}`,
    body,
  );
}

export function setWorkerConfig(
  target: RemoteTarget,
  workerId: string,
  configId: string,
  value: string,
): Promise<SetConfigResponse> {
  return call<SetConfigResponse>(
    target,
    "POST",
    `/v1/workers/${encodeURIComponent(workerId)}/config`,
    // The VALUE is sent as the operator typed it. `SetConfigBody` accepts a string, a number or a
    // boolean, and a CLI that guessed which one a config option wanted would be inventing a type
    // the agent never asked for — `true` is a legal string value for a text option.
    { configId, value },
  );
}

export function listRuns(target: RemoteTarget): Promise<RunListResponse> {
  return call<RunListResponse>(target, "GET", "/v1/runs");
}

export function listDeliveries(target: RemoteTarget): Promise<DeliveryListResponse> {
  return call<DeliveryListResponse>(target, "GET", "/v1/webhooks/deliveries");
}

export function redeliver(target: RemoteTarget, deliveryId: string): Promise<DeliveryRecord> {
  return call<DeliveryRecord>(
    target,
    "POST",
    `/v1/webhooks/deliveries/${encodeURIComponent(deliveryId)}/redeliver`,
  );
}

/**
 * The pending set, as a person reads it.
 *
 * `kind` and `method` come first because they are what decides which answer is legal: a
 * permission takes `--allow` / `--deny`, an elicitation takes `--value q=v`. The OPTIONS column
 * prints `optionId(kind)` pairs — never the option's `name`, which F27 recorded arriving under
 * three different spellings for one id, once with a path embedded in it.
 */
export function renderInteractions(body: InteractionListResponse): string {
  if (body.interactions.length === 0) return "no pending interactions";
  return renderTable(
    ["REQ", "KIND", "METHOD", "STATUS", "EXPIRES", "TITLE", "OPTIONS/FIELDS"],
    body.interactions.map((i) => [
      i.requestId,
      i.kind,
      i.method,
      i.status,
      i.expiresAt ?? "-",
      i.title,
      i.kind === "permission"
        ? i.options.map((o) => `${o.optionId}(${o.kind})`).join(" ")
        : i.fields.map((f) => f.id).join(" "),
    ]),
  );
}

export function renderConfig(body: SetConfigResponse): string {
  const lines = [
    renderTable(
      ["ID", "CURRENT", "NAME"],
      body.configOptions.map((o) => [
        o.id,
        String(o.currentValue ?? "-"),
        // `raw` is the agent's own entry BY IDENTITY (§7.5): a display name if it offered one,
        // and never a name this CLI invented for it.
        typeof o.raw["name"] === "string" ? o.raw["name"] : "-",
      ]),
    ),
  ];
  // F34's shrink is REAL, not a bug: a set can remove entries. Printing the delta is how an
  // operator sees that the control they were about to use is gone.
  if (body.removed.length > 0) lines.push(`removed: ${body.removed.join(", ")}`);
  if (body.added.length > 0) lines.push(`added: ${body.added.join(", ")}`);
  if (body.stale) lines.push("the agent returned no list; the previous one was KEPT");
  return lines.join("\n");
}

export function renderRuns(body: RunListResponse): string {
  if (body.runs.length === 0) return "no runs";
  return renderTable(
    ["ID", "STATE", "AGENT", "WORKER", "PERSIST", "WEBHOOK", "UPDATED"],
    body.runs.map((r) => [
      r.runId,
      r.state,
      r.agentId,
      r.workerId ?? "-",
      r.persistence,
      r.webhook === null ? "-" : `${String(r.webhook.deliveries)} to ${r.webhook.url}`,
      r.updatedAt,
    ]),
  );
}

export function renderDeliveries(body: DeliveryListResponse): string {
  if (body.deliveries.length === 0) return "no deliveries";
  return renderTable(
    ["ID", "RUN", "EVENT", "STATE", "ATTEMPT", "NEXT", "STATUS", "ERROR"],
    body.deliveries.map((d) => [
      d.deliveryId,
      d.runId,
      d.event,
      d.state,
      String(d.attempt),
      d.nextAttemptAt ?? "-",
      d.lastStatus === null ? "-" : String(d.lastStatus),
      d.lastError ?? "-",
    ]),
  );
}
