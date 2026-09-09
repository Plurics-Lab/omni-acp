import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agent as acpAgent, RequestError } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import {
  OmniError,
  type AcpErrorDetail,
  type AcpStream,
  type ConfigOptionView,
  type RuntimeDescriptor,
  type SessionStrategy,
  type StopReason,
  type WorkerHandle,
} from "@omni-acp/protocol";
import {
  fakeRuntime,
  loadTranscript,
  memoryStreamPair,
  nullLogger,
  type ScriptedAgent,
} from "@omni-acp/testkit";
import { BUILTIN_RUNTIMES, createNormalizer } from "../../src/index.js";
import { classifyError } from "../../src/normalizer/map/errors.js";
import { configOptionsDelta, viewConfigOptions } from "../../src/worker/config-options.js";
import { createSessionStrategy } from "../../src/worker/session-open.js";
import { flush, harness, OWNER, type Harness } from "./support/harness.js";

/**
 * `session/set_config_option` and the live catalogue (§22).
 *
 * Two halves, and the split is review R12's: `config-options.ts` holds the PURE lift and the
 * PURE delta and is golden-tested here against transcripts `15` (claude-acp) and `07` (codex-acp)
 * with no link at all, while the WIRE call lives in `Worker.setConfig` — M2-PLAN §1.2 hunk 6,
 * the only place holding the lease gate, the `worker_busy` gate, the auto-wake and the previous
 * list. The second half of this file drives that method through a real `AcpLink` against a
 * scripted agent, because every acceptance bullet about the spelling loop, the wholesale
 * replacement, the synthesized envelope and the status table is a statement about it.
 *
 * Owned by M2-A-WP-C.
 */

// ── the corpus, read here rather than through a shared helper ────────────────
//
// `@omni-acp/testkit`'s `loadTranscript` covers the claude-acp corpus; the codex-acp recordings
// are a DIFFERENT format (`[tMs] -> {json}` / `[tMs] <- {json}` / `[tMs] ## {note}` text lines,
// not JSONL) and testkit's barrel is frozen, so the six lines that read them live in the one file
// that needs them — the same rule `core/test/normalizer/support/corpus-facts.ts` records for its
// own derived queries.

const CLAUDE_15 = "15-set-config-option-model";
const CODEX_07 = "codex-acp-1.8.0/07-set-config-mode-and-effort.log";

interface WireMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
}

/** The agent's answer to the client request with this id, from a claude-acp `.jsonl`. */
function claudeResult(name: string, id: number): Record<string, unknown> {
  for (const line of loadTranscript(name)) {
    if (line.dir !== "agent->client") continue;
    const msg = line.msg as WireMessage | undefined;
    if (msg?.id === id && msg.result !== undefined) {
      return msg.result as Record<string, unknown>;
    }
  }
  throw new Error(`transcript ${name} has no result for id ${String(id)}`);
}

/** Every `->` / `<-` frame of a codex-acp `.log`, in wire order. */
function codexFrames(file: string): readonly { dir: "->" | "<-"; msg: WireMessage }[] {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/core/test/worker -> packages/core/test -> packages/core -> packages -> <repo root>
  const path = join(here, "..", "..", "..", "..", "docs", "research", "transcripts", file);
  const out: { dir: "->" | "<-"; msg: WireMessage }[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\[[\d.]+\] (->|<-) (.*)$/.exec(line);
    if (match === null) continue;
    out.push({ dir: match[1] as "->" | "<-", msg: JSON.parse(match[2] ?? "") as WireMessage });
  }
  return out;
}

function codexResult(file: string, id: number): Record<string, unknown> {
  for (const frame of codexFrames(file)) {
    if (frame.dir === "<-" && frame.msg.id === id && frame.msg.result !== undefined) {
      return frame.msg.result as Record<string, unknown>;
    }
  }
  throw new Error(`transcript ${file} has no result for id ${String(id)}`);
}

const entriesOf = (body: Record<string, unknown>): readonly Record<string, unknown>[] =>
  body["configOptions"] as readonly Record<string, unknown>[];

/** claude-acp's real descriptor — two `setConfig` spellings and the F17/F44 error rules. */
const CLAUDE: RuntimeDescriptor = (() => {
  const row = BUILTIN_RUNTIMES.find((r) => r.matches.includes("claude-acp"));
  if (row === undefined) throw new Error("no builtin descriptor for claude-acp");
  return row.descriptor;
})();

const ids = (views: readonly ConfigOptionView[] | null): readonly string[] =>
  (views ?? []).map((v) => v.id);

const valueOf = (views: readonly ConfigOptionView[] | null, id: string): unknown =>
  (views ?? []).find((v) => v.id === id)?.currentValue;

// ── the PURE half ────────────────────────────────────────────────────────────

describe("viewConfigOptions over the recorded corpora (F34, F35)", () => {
  it("claude 15: the METHOD's own result replaces four entries with two, and no phantom `effort` survives", () => {
    // `session/new` (client request id 2) and `session/set_config_option` (id 3) — the two
    // bodies F34 is a claim about, read from the checked-in bytes rather than restated here.
    const created = claudeResult(CLAUDE_15, 2);
    const set = claudeResult(CLAUDE_15, 3);

    const before = viewConfigOptions(created, CLAUDE);
    const after = viewConfigOptions(set, CLAUDE);

    expect(ids(before)).toEqual(["mode", "model", "effort", "fast"]);
    expect(ids(after)).toEqual(["mode", "model"]);
    // The whole of F34 in one line: Haiku exposes no effort levels, so a MERGE by id would leave
    // a control on the snapshot that the agent will now refuse.
    expect(ids(after)).not.toContain("effort");
    expect(ids(after)).not.toContain("fast");
    expect(valueOf(before, "model")).toBe("default");
    expect(valueOf(after, "model")).toBe("haiku");
  });

  it("claude 15: the membership delta names the shrink and nothing else", () => {
    const before = viewConfigOptions(claudeResult(CLAUDE_15, 2), CLAUDE);
    const after = viewConfigOptions(claudeResult(CLAUDE_15, 3), CLAUDE);

    expect(configOptionsDelta(before, after)).toEqual({
      removed: ["effort", "fast"],
      added: [],
    });
    // `model` changed VALUE and not membership: a delta that reported it would tell a client to
    // re-render a control that is still there.
    expect(configOptionsDelta(before, after).removed).not.toContain("model");
  });

  it("codex 07: all five entries survive every set, and the delta is empty both times", () => {
    // Request ids 3 (`mode` → read-only) and 4 (`reasoning_effort` → high) — F35's counter-example
    // to claude's shrink, which is what makes wholesale replacement the only correct handling.
    const created = viewConfigOptions(codexResult(CODEX_07, 2), fakeRuntime());
    const afterMode = viewConfigOptions(codexResult(CODEX_07, 3), fakeRuntime());
    const afterEffort = viewConfigOptions(codexResult(CODEX_07, 4), fakeRuntime());

    const five = ["mode", "collaboration_mode", "model", "reasoning_effort", "fast-mode"];
    expect(ids(created)).toEqual(five);
    expect(ids(afterMode)).toEqual(five);
    expect(ids(afterEffort)).toEqual(five);

    expect(configOptionsDelta(created, afterMode)).toEqual({ removed: [], added: [] });
    expect(configOptionsDelta(afterMode, afterEffort)).toEqual({ removed: [], added: [] });

    expect(valueOf(created, "mode")).toBe("agent");
    expect(valueOf(afterMode, "mode")).toBe("read-only");
    expect(valueOf(afterMode, "reasoning_effort")).toBe("medium");
    expect(valueOf(afterEffort, "reasoning_effort")).toBe("high");
  });

  it("codex 07: `raw` is the agent's own object BY IDENTITY, and the two model spellings both survive untouched (F35)", () => {
    const body = codexResult(CODEX_07, 2);
    const wire = entriesOf(body);
    const views = viewConfigOptions(body, fakeRuntime());

    // Identity, not deep equality: `Worker.setConfig` feeds `raw` straight back into the
    // synthesized `config_option_update`, so a rebuilt object would put a shape we invented on
    // the wire under the agent's name.
    expect(views).not.toBeNull();
    for (const [index, view] of (views ?? []).entries()) {
      expect(view.raw).toBe(wire[index]);
    }

    // F35's exact hazard: codex spells its model id ONE way in `models.availableModels[].modelId`
    // and ANOTHER in `configOptions[model].currentValue`. Anything that normalized either would
    // make a snapshot fail to match itself.
    const models = body["models"] as { availableModels: { modelId: string }[] };
    expect(models.availableModels[0]?.modelId).toBe("gpt-5.6-sol[low]");
    expect(valueOf(views, "model")).toBe("gpt-5.6-sol");
    expect(valueOf(views, "model")).not.toBe(models.availableModels[0]?.modelId);
  });

  it("the entry key is MEASURED, not a quirk: two descriptors that disagree about configIdField see the same view (§22.1 trap 3)", () => {
    const body = claudeResult(CLAUDE_15, 3);
    const asConfigId = viewConfigOptions(body, fakeRuntime());
    const asOptionId = viewConfigOptions(
      body,
      fakeRuntime({ quirks: { ...fakeRuntime().quirks, configIdField: "optionId" } }),
    );

    // Review R3: the REQUEST word is a quirk (`Quirks.configIdField`, handled by
    // `Normalizer.mapRequest`); the ENTRY word is `id` on both corpora and there is no second
    // quirk to keep in sync. Deep-equal AND identical `raw` references.
    expect(asOptionId).toEqual(asConfigId);
    expect(asOptionId?.[0]?.raw).toBe(asConfigId?.[0]?.raw);
  });
});

describe("viewConfigOptions is PURE and TOTAL", () => {
  it("answers null for every body that carries no list, and never throws", () => {
    const unreadable: unknown[] = [
      null,
      undefined,
      42,
      "configOptions",
      true,
      [],
      [{ id: "mode" }],
      {},
      { configOptions: null },
      { configOptions: 42 },
      { configOptions: "mode,model" },
      { configOptions: { mode: {} } },
    ];
    for (const body of unreadable) {
      expect(viewConfigOptions(body, CLAUDE)).toBeNull();
    }
  });

  it("distinguishes `[]` from null — the agent offering nothing is not the method answering nothing", () => {
    // The distinction IS `SetConfigResponse.stale`: `null` keeps the previous catalogue, `[]`
    // replaces it with an empty one. Collapsing them is how F34's dropped `effort` comes back.
    expect(viewConfigOptions({ configOptions: [] }, CLAUDE)).toEqual([]);
    expect(viewConfigOptions({ configOptions: [] }, CLAUDE)).not.toBeNull();
  });

  it("drops an entry nobody could address, and keeps the rest rather than discarding the body", () => {
    const views = viewConfigOptions(
      {
        configOptions: [
          { id: "mode", currentValue: "default" },
          null,
          "effort",
          [],
          { name: "no id at all" },
          { id: "", currentValue: "x" },
          { id: 7, currentValue: "x" },
          { id: "model", currentValue: "haiku" },
        ],
      },
      CLAUDE,
    );
    // Answering `null` here would mean "keep the previous list", and one unreadable row must
    // never resurrect four entries the agent just dropped.
    expect(ids(views)).toEqual(["mode", "model"]);
  });

  it("carries `currentValue` verbatim, including absent, null and non-string values", () => {
    const views = viewConfigOptions(
      {
        configOptions: [
          { id: "a" },
          { id: "b", currentValue: null },
          { id: "c", currentValue: false },
          { id: "d", currentValue: 3 },
          { id: "e", currentValue: { nested: true } },
        ],
      },
      CLAUDE,
    );
    expect((views ?? []).map((v) => v.currentValue)).toEqual([
      undefined,
      null,
      false,
      3,
      { nested: true },
    ]);
  });

  it("does not mutate the body it was handed", () => {
    const body = JSON.parse(JSON.stringify(claudeResult(CLAUDE_15, 3))) as Record<string, unknown>;
    const before = JSON.stringify(body);
    viewConfigOptions(body, CLAUDE);
    expect(JSON.stringify(body)).toBe(before);
  });
});

describe("configOptionsDelta is PURE and TOTAL", () => {
  const view = (id: string): ConfigOptionView => ({ id, currentValue: null, raw: { id } });

  it("is the membership delta, in each catalogue's own order", () => {
    const rows: {
      previous: readonly ConfigOptionView[] | null;
      next: readonly ConfigOptionView[] | null;
      removed: string[];
      added: string[];
    }[] = [
      { previous: null, next: null, removed: [], added: [] },
      // "We held no catalogue" makes every entry new, which is exactly what a client renders.
      {
        previous: null,
        next: [view("mode"), view("model")],
        removed: [],
        added: ["mode", "model"],
      },
      { previous: [view("mode")], next: null, removed: ["mode"], added: [] },
      { previous: [], next: [], removed: [], added: [] },
      {
        previous: [view("mode"), view("model"), view("effort"), view("fast")],
        next: [view("mode"), view("model")],
        removed: ["effort", "fast"],
        added: [],
      },
      {
        previous: [view("mode")],
        next: [view("mode"), view("model"), view("effort")],
        removed: [],
        added: ["model", "effort"],
      },
      // Re-ORDERING is not membership churn: nothing appeared and nothing went away.
      {
        previous: [view("mode"), view("model")],
        next: [view("model"), view("mode")],
        removed: [],
        added: [],
      },
      {
        previous: [view("a"), view("b")],
        next: [view("b"), view("c")],
        removed: ["a"],
        added: ["c"],
      },
      // A duplicated id is named ONCE, so `removed`/`added` stay sets a client can iterate.
      {
        previous: [view("mode"), view("mode"), view("model")],
        next: [view("mode")],
        removed: ["model"],
        added: [],
      },
    ];
    for (const row of rows) {
      expect(configOptionsDelta(row.previous, row.next)).toEqual({
        removed: row.removed,
        added: row.added,
      });
    }
  });

  it("is deterministic and mutates neither argument", () => {
    const previous = [view("mode"), view("model"), view("effort")];
    const next = [view("mode"), view("model")];
    const first = configOptionsDelta(previous, next);
    for (let i = 0; i < 100; i += 1) {
      expect(configOptionsDelta(previous, next)).toEqual(first);
    }
    expect(ids(previous)).toEqual(["mode", "model", "effort"]);
    expect(ids(next)).toEqual(["mode", "model"]);
  });

  it("`stale` is expressible as `delta(previous, previous)`, which is empty by construction", () => {
    // `Worker.setConfig` passes the previous list on BOTH sides when the method returned no list,
    // so a stale answer can never report churn it did not observe.
    const previous = viewConfigOptions(claudeResult(CLAUDE_15, 2), CLAUDE);
    expect(configOptionsDelta(previous, previous)).toEqual({ removed: [], added: [] });
  });
});

describe("the WP-C sources name neither request spelling", () => {
  const sourceOf = (relative: string): string => {
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, "..", "..", relative), "utf8");
  };

  /** Comments are prose; the guard is about CODE. */
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

  it("`configId` and `optionId` are both absent from config-options.ts's code (§22.1 trap 3)", () => {
    const code = stripComments(sourceOf(join("src", "worker", "config-options.ts")));
    // The REQUEST word is descriptor data (`Quirks.configIdField`, applied by
    // `Normalizer.mapRequest`) and the ENTRY word is `id`. This file decides neither, so naming
    // either one here would be a second translation layer nobody could keep in sync.
    expect(code).not.toContain("configId");
    expect(code).not.toContain("optionId");
    // …and the guard is worth something only if it can fail: the prose above says both words.
    expect(sourceOf(join("src", "worker", "config-options.ts"))).toContain("configIdField");
  });
});

// ── the WIRE half: `Worker.setConfig` (M2-PLAN §1.2 hunk 6) ──────────────────

type ScriptedAnswer =
  | { readonly result: unknown }
  | { readonly error: { code: number; message: string; data?: Record<string, unknown> } };

interface ConfigAgentOptions {
  /** `session/new`'s body. `undefined` ⇒ no `configOptions` key at all. */
  readonly created?: readonly unknown[];
  /** `session/resume`'s body — §22.2's "a wake re-seeds from `reopen`'s result". */
  readonly resumed?: readonly unknown[];
  /** Answers to `session/set_config_option`, in order. An exhausted queue is `-32601`. */
  readonly setConfigOption?: readonly ScriptedAnswer[];
  /** Answers to `session/set_mode` — claude-acp's SECOND spelling (F18, §17.3). */
  readonly setMode?: readonly ScriptedAnswer[];
}

interface ConfigAgent {
  readonly stream: AcpStream;
  /** Every request this agent was asked for, in wire order — method AND params. */
  readonly calls: readonly { method: string; params: Record<string, unknown> }[];
  /** Emit a `session/update` the way a real agent does — the PLANTED spurious notification. */
  update(u: Record<string, unknown>): Promise<void>;
  resolvePrompt(stopReason: StopReason): void;
  die(): void;
}

/**
 * An ACP v1 agent that answers `session/set_config_option` — the one thing neither testkit's
 * `scriptedAgent()` nor this package's `rawAgent()` / `resumableAgent()` models, and the one
 * thing §22 is entirely about.
 *
 * It is scripted per SPELLING rather than per capability, because §17.3's preference order is
 * the subject: claude-acp answers `session/set_config_option` AND `session/set_mode` on ONE
 * process (F18), and a fixture with a single handler could not express a `-32601` on the first
 * that falls through to the second.
 */
function configAgent(opts: ConfigAgentOptions = {}): ConfigAgent {
  const [clientSide, agentSide] = memoryStreamPair();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const queues: Record<string, ScriptedAnswer[]> = {
    "session/set_config_option": [...(opts.setConfigOption ?? [])],
    "session/set_mode": [...(opts.setMode ?? [])],
  };
  let sessionId = "cfg_1";
  let pending: ((r: { stopReason: string }) => void) | null = null;
  let queuedStop: StopReason | null = null;
  let dead = false;

  const paramsOf = (ctx: unknown): Record<string, unknown> => {
    const raw = (ctx as { params?: unknown } | null)?.params;
    return (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  };

  const answer = (method: string, ctx: unknown): unknown => {
    calls.push({ method, params: paramsOf(ctx) });
    const next = queues[method]?.shift();
    if (next === undefined) {
      // F17's shape verbatim: the message embeds the method in quotes inside quotes, and
      // `data.method` carries the same fact in a FIELD — which is why the classifier keys on the
      // code and the pointer and never on this text.
      throw new RequestError(-32601, `"Method not found": ${method}`, { method });
    }
    if ("error" in next) {
      throw new RequestError(next.error.code, next.error.message, next.error.data);
    }
    return next.result;
  };

  const app = acpAgent({ name: "config-agent" })
    .onRequest("initialize", (ctx: unknown) => {
      calls.push({ method: "initialize", params: paramsOf(ctx) });
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { close: {}, resume: {}, list: {} },
        } as Record<string, never>,
      };
    })
    .onRequest("session/new", (ctx: unknown) => {
      calls.push({ method: "session/new", params: paramsOf(ctx) });
      return {
        sessionId,
        ...(opts.created === undefined ? {} : { configOptions: [...opts.created] }),
      };
    })
    .onRequest("session/resume", (ctx: unknown) => {
      calls.push({ method: "session/resume", params: paramsOf(ctx) });
      const asked = paramsOf(ctx)["sessionId"];
      sessionId = typeof asked === "string" ? asked : sessionId;
      return {
        sessionId,
        ...(opts.resumed === undefined ? {} : { configOptions: [...opts.resumed] }),
      };
    })
    // The THREE-ARGUMENT form, deliberately: the SDK's built-in spec for
    // `session/set_config_option` zod-parses its params and would answer `-32602` for a request
    // spelled `optionId` — which is F34's own finding and NOT what these tests are measuring.
    // An identity parser makes this fixture record what actually crossed the wire, so the quirk
    // is asserted on the BYTES rather than on our intention.
    .onRequest(
      "session/set_config_option",
      (p: unknown) => p as Record<string, unknown>,
      (ctx: unknown) => answer("session/set_config_option", ctx),
    )
    .onRequest(
      "session/set_mode",
      (p: unknown) => p as Record<string, unknown>,
      (ctx: unknown) => answer("session/set_mode", ctx),
    )
    .onRequest("session/close", () => ({}))
    .onRequest(
      "session/prompt",
      (ctx: unknown) =>
        new Promise<{ stopReason: string }>((resolve) => {
          calls.push({ method: "session/prompt", params: paramsOf(ctx) });
          if (queuedStop !== null) {
            const stopReason = queuedStop;
            queuedStop = null;
            resolve({ stopReason });
            return;
          }
          pending = resolve;
        }),
    )
    .onNotification("session/cancel", () => {});

  const connection = app.connect(agentSide);
  const cx = connection.client;

  return {
    stream: clientSide,
    calls,
    async update(u) {
      await cx.notify("session/update", { sessionId, update: u });
    },
    resolvePrompt(stopReason) {
      const resolve = pending;
      pending = null;
      if (resolve === null) {
        queuedStop = stopReason;
        return;
      }
      resolve({ stopReason });
    },
    die() {
      if (dead) return;
      dead = true;
      pending = null;
      connection.close(new Error("config agent died"));
    },
  };
}

/** `fakeSupervisor().enqueue` only ever touches `.stream` and `.die()` (see `resumable-agent.ts`). */
const asScripted = (agent: ConfigAgent): ScriptedAgent => agent as unknown as ScriptedAgent;

interface Rig {
  readonly h: Harness;
  readonly worker: WorkerHandle;
  readonly agent: ConfigAgent;
  /** Enqueues the agent the NEXT spawn (i.e. the next wake) will be wired to. */
  next(o?: ConfigAgentOptions): ConfigAgent;
}

const strategyFor = (h: Harness, descriptor: RuntimeDescriptor): SessionStrategy =>
  createSessionStrategy({ descriptor, clock: h.clock, logger: nullLogger() });

async function rig(o?: {
  agent?: ConfigAgentOptions;
  descriptor?: RuntimeDescriptor;
}): Promise<Rig> {
  const h = harness();
  const descriptor = o?.descriptor ?? CLAUDE;
  const agents: ConfigAgent[] = [];
  const next = (opts: ConfigAgentOptions = {}): ConfigAgent => {
    const agent = configAgent(opts);
    agents.push(agent);
    h.supervisor.enqueue(asScripted(agent));
    return agent;
  };
  const first = next(o?.agent ?? {});

  const worker = await h.create({
    overrides: {
      // The REAL normalizer, not the harness's lifecycle double: `mapRequest` and
      // `noteUnsupported` ARE the subject of §17.3's spelling loop, and the double throws on
      // both by design.
      normalizer: createNormalizer({ quietMs: 250, hardMs: 5_000, descriptor }),
      runtime: descriptor,
      session: strategyFor(h, descriptor),
    },
  });

  return { h, worker, agent: first, next };
}

const CLAUDE_CREATED = entriesOf(claudeResult(CLAUDE_15, 2));
const CLAUDE_SET = claudeResult(CLAUDE_15, 3);

describe("Worker.setConfig — the wholesale replacement (§22.2, F34)", () => {
  it("replaces WorkerSnapshot.configOptions from the METHOD's own result, 4 -> 2, with no phantom effort", async () => {
    const r = await rig({
      agent: { created: CLAUDE_CREATED, setConfigOption: [{ result: CLAUDE_SET }] },
    });

    // Seeded from the handshake's `session/new` body (§22.2's snapshot row).
    expect(ids(r.worker.snapshot().configOptions ?? null)).toEqual([
      "mode",
      "model",
      "effort",
      "fast",
    ]);

    const response = await r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER);

    expect(ids(response.configOptions)).toEqual(["mode", "model"]);
    expect(response.removed).toEqual(["effort", "fast"]);
    expect(response.added).toEqual([]);
    expect(response.stale).toBe(false);
    expect(ids(r.worker.snapshot().configOptions ?? null)).toEqual(["mode", "model"]);
    expect(ids(r.worker.snapshot().configOptions ?? null)).not.toContain("effort");
    expect(valueOf(r.worker.snapshot().configOptions ?? null, "model")).toBe("haiku");

    await r.worker.close("client_request");
  });

  it("AgentCapabilitiesSnapshot.configOptions is the HISTORICAL record and is UNCHANGED by the call", async () => {
    const r = await rig({
      agent: { created: CLAUDE_CREATED, setConfigOption: [{ result: CLAUDE_SET }] },
    });
    const frozenAtHandshake = r.worker.snapshot().capabilities?.configOptions;
    expect((frozenAtHandshake ?? []).length).toBe(4);

    await r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER);

    // §22.2: the live list moved; the handshake record did not. Identity, so a future refactor
    // that "refreshed" it would fail here rather than silently rewrite history.
    expect(r.worker.snapshot().capabilities?.configOptions).toBe(frozenAtHandshake);
    expect((r.worker.snapshot().capabilities?.configOptions ?? []).length).toBe(4);

    await r.worker.close("client_request");
  });

  it("codex 07's five entries all survive, and the response reports no churn", async () => {
    const created = entriesOf(codexResult(CODEX_07, 2));
    const afterMode = codexResult(CODEX_07, 3);
    const r = await rig({
      // codex-acp has no builtin descriptor row yet (M2-WP-J's), so the shape of the DATA is
      // what is asserted here: a generic v1 profile that names the one spelling.
      descriptor: fakeRuntime({
        prefer: {
          ...fakeRuntime().prefer,
          setConfig: { spellings: ["session/set_config_option"], onFailure: "fail" },
        },
      }),
      agent: { created, setConfigOption: [{ result: afterMode }] },
    });

    const response = await r.worker.setConfig({ configId: "mode", value: "read-only" }, OWNER);

    expect(ids(response.configOptions)).toEqual([
      "mode",
      "collaboration_mode",
      "model",
      "reasoning_effort",
      "fast-mode",
    ]);
    expect(response.removed).toEqual([]);
    expect(response.added).toEqual([]);
    expect(response.stale).toBe(false);
    expect(valueOf(response.configOptions, "mode")).toBe("read-only");

    await r.worker.close("client_request");
  });
});

describe("Worker.setConfig — the spelling is DESCRIPTOR DATA (§17.3, F34)", () => {
  it("sends the canonical `configId` under claude-acp's quirk table", async () => {
    const r = await rig({
      agent: { created: CLAUDE_CREATED, setConfigOption: [{ result: CLAUDE_SET }] },
    });
    await r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER);

    const call = r.agent.calls.find((c) => c.method === "session/set_config_option");
    expect(call?.params).toEqual({ sessionId: "cfg_1", configId: "model", value: "haiku" });

    await r.worker.close("client_request");
  });

  it("sends `optionId` for a runtime whose quirk says so — the same route, no branch", async () => {
    const descriptor = fakeRuntime({
      prefer: {
        ...fakeRuntime().prefer,
        setConfig: { spellings: ["session/set_config_option"], onFailure: "fail" },
      },
      quirks: { ...fakeRuntime().quirks, configIdField: "optionId" },
    });
    const r = await rig({
      descriptor,
      agent: { created: CLAUDE_CREATED, setConfigOption: [{ result: CLAUDE_SET }] },
    });

    await r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER);

    const call = r.agent.calls.find((c) => c.method === "session/set_config_option");
    // The DAEMON's body still names `configId` (§5.8.5's `SetConfigBody`); the WIRE names what
    // the descriptor says. That is the whole of trap 3.
    expect(call?.params).toEqual({ sessionId: "cfg_1", optionId: "model", value: "haiku" });
    expect(Object.keys(call?.params ?? {})).not.toContain("configId");

    await r.worker.close("client_request");
  });

  it("a -32601 retires the first spelling and the SECOND is tried (F18: both are live on one process)", async () => {
    const r = await rig({
      agent: {
        created: CLAUDE_CREATED,
        setConfigOption: [{ error: { code: -32601, message: '"Method not found"' } }],
        // claude-acp answers `session/set_mode` with `{}` (M1 finding 11) — no list at all.
        setMode: [{ result: {} }],
      },
    });

    const response = await r.worker.setConfig({ configId: "mode", value: "plan" }, OWNER);

    expect(r.agent.calls.map((c) => c.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_config_option",
      "session/set_mode",
    ]);
    // Row 25's param rename: `{configId, value}` becomes `{modeId}` for THAT spelling.
    //
    // ONLY `modeId` is asserted, and that is deliberate rather than lazy. `map/methods.ts`'s
    // row-25 rule is `(p) => ({modeId: p["value"]})`, which DROPS `sessionId` — while corpus `08`
    // id 6 records the real `session/set_mode` being called with `{sessionId, modeId}`. That file
    // belongs to M1-WP-B and is outside this work package's ownership map, so the defect is
    // reported in the WP notes with the exact change rather than pinned here in either direction.
    const setMode = r.agent.calls.find((c) => c.method === "session/set_mode");
    expect(setMode?.params["modeId"]).toBe("plan");

    // The second spelling returned NO list ⇒ `stale`, and the previous one is KEPT.
    expect(response.stale).toBe(true);
    expect(ids(response.configOptions)).toEqual(["mode", "model", "effort", "fast"]);
    expect(response.removed).toEqual([]);
    expect(response.added).toEqual([]);
    expect(ids(r.worker.snapshot().configOptions ?? null)).toEqual([
      "mode",
      "model",
      "effort",
      "fast",
    ]);

    await r.worker.close("client_request");
  });

  it("the retirement is remembered: a second call goes straight to the surviving spelling", async () => {
    const r = await rig({
      agent: {
        created: CLAUDE_CREATED,
        setConfigOption: [{ error: { code: -32601, message: '"Method not found"' } }],
        setMode: [{ result: {} }, { result: {} }],
      },
    });

    await r.worker.setConfig({ configId: "mode", value: "plan" }, OWNER);
    await r.worker.setConfig({ configId: "mode", value: "default" }, OWNER);

    // `noteUnsupported` is per PROCESS and never persisted (§17.3), so the retired spelling is
    // not retried within this worker's life.
    expect(r.agent.calls.filter((c) => c.method === "session/set_config_option")).toHaveLength(1);
    expect(r.agent.calls.filter((c) => c.method === "session/set_mode")).toHaveLength(2);

    await r.worker.close("client_request");
  });

  it("a -32602 is the AGENT's answer and does NOT fall through: one call, reported verbatim (F34)", async () => {
    // F34 measured `optionId` answering `-32602` on claude-acp. That is what makes the request
    // word a QUIRK rather than a fallback chain: a wrong parameter name is a bad request, not an
    // unimplemented method, and walking to the next spelling would hide it.
    const r = await rig({
      agent: {
        created: CLAUDE_CREATED,
        setConfigOption: [
          {
            error: {
              code: -32602,
              message: "Invalid params",
              data: { configId: { _errors: ["Required"] } },
            },
          },
        ],
        setMode: [{ result: {} }],
      },
    });

    const failure = await r.worker
      .setConfig({ configId: "model", value: "haiku" }, OWNER)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(OmniError.is(failure, "agent_error")).toBe(true);
    expect((failure as OmniError).acp?.code).toBe(-32602);
    expect(r.agent.calls.filter((c) => c.method === "session/set_mode")).toHaveLength(0);
    // …and nothing moved.
    expect(ids(r.worker.snapshot().configOptions ?? null)).toEqual([
      "mode",
      "model",
      "effort",
      "fast",
    ]);

    await r.worker.close("client_request");
  });

  it("every spelling exhausted is `agent_error` carrying -32601 — the shape a client already reads (D29)", async () => {
    const r = await rig({
      agent: {
        created: CLAUDE_CREATED,
        setConfigOption: [{ error: { code: -32601, message: "no" } }],
        setMode: [{ error: { code: -32601, message: "no" } }],
      },
    });

    const failure = await r.worker
      .setConfig({ configId: "model", value: "haiku" }, OWNER)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(OmniError.is(failure, "agent_error")).toBe(true);
    expect((failure as OmniError).acp?.code).toBe(-32601);

    await r.worker.close("client_request");
  });

  it("a descriptor that advertises NO spelling never touches the wire", async () => {
    // `DEFAULT_V1_PROFILE.prefer.setConfig.spellings` is `[]` — the honest "we have proved
    // nothing about this agent" — so the answer is `-32601` with zero requests sent.
    const r = await rig({ descriptor: fakeRuntime(), agent: { created: CLAUDE_CREATED } });

    const failure = await r.worker
      .setConfig({ configId: "model", value: "haiku" }, OWNER)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(OmniError.is(failure, "agent_error")).toBe(true);
    expect((failure as OmniError).acp?.code).toBe(-32601);
    expect(r.agent.calls.map((c) => c.method)).toEqual(["initialize", "session/new"]);

    await r.worker.close("client_request");
  });
});

describe("Worker.setConfig — the bad-value path (§22.2, F44)", () => {
  const BAD_VALUE: AcpErrorDetail = {
    code: -32603,
    message: "Internal error",
    data: { details: "Invalid value for config option model: no-such-model-xyz" },
  };

  it("is 502 agent_error carrying the -32603 and its data.details VERBATIM", async () => {
    const r = await rig({
      agent: {
        created: CLAUDE_CREATED,
        setConfigOption: [
          {
            error: {
              code: BAD_VALUE.code,
              message: BAD_VALUE.message,
              data: BAD_VALUE.data as Record<string, unknown>,
            },
          },
        ],
      },
    });

    const failure = await r.worker
      .setConfig({ configId: "model", value: "no-such-model-xyz" }, OWNER)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(OmniError.is(failure, "agent_error")).toBe(true);
    const acp = (failure as OmniError).acp;
    expect(acp?.code).toBe(-32603);
    expect(acp?.data).toEqual({
      details: "Invalid value for config option model: no-such-model-xyz",
    });
    // A refused value changes nothing, and the catalogue must say so.
    expect(ids(r.worker.snapshot().configOptions ?? null)).toEqual([
      "mode",
      "model",
      "effort",
      "fast",
    ]);
    // It never fell through to `session/set_mode`: `-32603` is the agent's answer, not "this
    // method does not exist".
    expect(r.agent.calls.filter((c) => c.method === "session/set_mode")).toHaveLength(0);

    await r.worker.close("client_request");
  });

  it("the descriptor classifies it on CODE + a data pointer, never on message text", () => {
    // §22.2's classification half, asserted where classification lives. The claude-acp descriptor
    // carries `bad-config-value` = {code:-32603, dataPointer:"/details", dataMatches:"^Invalid
    // value for config option "}, which separates a wrong VALUE from a genuine internal error —
    // the two share `-32603` and differ only in `data`.
    expect(classifyError(BAD_VALUE, CLAUDE)).toEqual({ kind: "bad_request" });

    // The MESSAGE is not a contract: rewrite it and the classification is unchanged.
    expect(classifyError({ ...BAD_VALUE, message: "totally different prose" }, CLAUDE)).toEqual({
      kind: "bad_request",
    });

    // The POINTER is: a genuine internal error with the same code and no `/details` is NOT
    // reclassified, and neither is one whose details say something else.
    expect(classifyError({ code: -32603, message: "Internal error" }, CLAUDE)).toEqual({
      kind: "unclassified",
    });
    expect(
      classifyError(
        { code: -32603, message: "Internal error", data: { details: "disk full" } },
        CLAUDE,
      ),
    ).toEqual({ kind: "unclassified" });

    // And the sibling rule that F17 records, on the same principle: `-32601` is classified from
    // `data.method`, not from the quotes-inside-quotes message.
    expect(
      classifyError(
        {
          code: -32601,
          message: '"Method not found": session/set_model',
          data: { method: "session/set_model" },
        },
        CLAUDE,
      ),
    ).toEqual({ kind: "unsupported_method", method: "session/set_model" });
  });
});

describe("Worker.setConfig — ZERO agent-emitted config_option_update is consumed (§22.1 trap 1)", () => {
  it("a stream that carries no notification still sees the new value, and the synthesized envelope is stamped", async () => {
    const r = await rig({
      agent: { created: CLAUDE_CREATED, setConfigOption: [{ result: CLAUDE_SET }] },
    });
    const before = r.h.log.all.length;

    await r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER);
    await flush();

    // Nothing arrived on the stream — F34/F35: neither real agent notifies for a set — and the
    // snapshot moved anyway, because it is refreshed from the METHOD's own result.
    expect(valueOf(r.worker.snapshot().configOptions ?? null, "model")).toBe("haiku");

    const synthesized = r.h.log.all
      .slice(before)
      .filter(
        (e) =>
          e.kind === "acp.session_update" &&
          (e.payload as { sessionUpdate?: string }).sessionUpdate === "config_option_update",
      );
    expect(synthesized).toHaveLength(1);
    const payload = synthesized[0]?.payload as {
      configOptions: unknown[];
      _meta: Record<string, unknown>;
    };
    // M2-R23: the daemon synthesizes what the agent does not send, and STAMPS it so an
    // agent-emitted one stays distinguishable from ours.
    expect(payload._meta["omni/source"]).toBe("set_config_option");
    expect(payload.configOptions).toHaveLength(2);
    // Fed as an `agent_update`, so the DESCRIPTOR decided the mapping — and it landed on the v2
    // arm rather than being forwarded as an unknown shape.
    expect(synthesized[0]?.payloadVersion).toBe(2);

    await r.worker.close("client_request");
  });

  it("a PLANTED spurious config_option_update from the agent is ignored by the snapshot", async () => {
    const r = await rig({ agent: { created: CLAUDE_CREATED } });

    // Exactly the shape a notifying agent would send — and a two-entry list, so a reader that
    // consumed it would show the same 4 -> 2 shrink the METHOD produces. It must not.
    await r.agent.update({
      sessionUpdate: "config_option_update",
      configOptions: entriesOf(CLAUDE_SET),
    });
    await flush();

    // It reached the LOG — dropping an agent's update would be a different bug — but the live
    // catalogue is unmoved, because it is only ever written from a method result.
    const arrived = r.h.log.all.filter(
      (e) =>
        e.kind === "acp.session_update" &&
        (e.payload as { sessionUpdate?: string }).sessionUpdate === "config_option_update",
    );
    expect(arrived).toHaveLength(1);
    expect((arrived[0]?.payload as { _meta?: unknown })._meta).toBeUndefined();
    expect(ids(r.worker.snapshot().configOptions ?? null)).toEqual([
      "mode",
      "model",
      "effort",
      "fast",
    ]);

    await r.worker.close("client_request");
  });
});

describe("Worker.setConfig — the gates (§22.2)", () => {
  it("asserts the lease holder FIRST, before any state check", async () => {
    const r = await rig({ agent: { created: CLAUDE_CREATED } });
    const before = r.h.lease.asserted.length;

    await r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER).catch(() => undefined);

    expect(r.h.lease.asserted.length).toBe(before + 1);

    await r.worker.close("client_request");
  });

  it("409 worker_busy while a turn is live (M2-R22: unknown, not forbidden)", async () => {
    const r = await rig({
      agent: { created: CLAUDE_CREATED, setConfigOption: [{ result: CLAUDE_SET }] },
    });
    await r.worker.prompt([{ type: "text", text: "hello" }], OWNER);
    await flush();
    expect(r.worker.snapshot().state).toBe("running");

    const failure = await r.worker
      .setConfig({ configId: "model", value: "haiku" }, OWNER)
      .then(() => null)
      .catch((e: unknown) => e);

    expect(OmniError.is(failure, "worker_busy")).toBe(true);
    // No agent was ever observed accepting a mid-turn set, so nothing reached the wire.
    expect(r.agent.calls.filter((c) => c.method === "session/set_config_option")).toHaveLength(0);

    // Settle the turn before closing: the close-out ladder walks on the FAKE clock, so leaving a
    // live turn behind would hang the teardown rather than the assertion.
    r.agent.resolvePrompt("end_turn");
    await flush();
    r.h.clock.advance(250);
    await flush();
    expect(r.worker.snapshot().state).toBe("ready");

    // …and the SAME call succeeds the moment the turn is over, which is what makes the `409` a
    // gate rather than a refusal.
    await expect(
      r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER),
    ).resolves.toMatchObject({ stale: false });

    await r.worker.close("client_request");
  });

  it("`ready` succeeds and `closed` is worker_closed", async () => {
    const r = await rig({
      agent: { created: CLAUDE_CREATED, setConfigOption: [{ result: CLAUDE_SET }] },
    });
    expect(r.worker.snapshot().state).toBe("ready");
    await expect(
      r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER),
    ).resolves.toMatchObject({ stale: false });

    await r.worker.close("client_request");

    const failure = await r.worker
      .setConfig({ configId: "model", value: "haiku" }, OWNER)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(OmniError.is(failure, "worker_closed")).toBe(true);
  });

  it("auto-wakes a hibernated worker exactly as prompt does, and the wake RE-SEEDS the catalogue", async () => {
    // §22.2's snapshot row: "a wake re-seeds the live list from `reopen`'s result, because a
    // resumed session may report a different catalogue".
    const r = await rig({ agent: { created: CLAUDE_CREATED } });
    expect(ids(r.worker.snapshot().configOptions ?? null)).toEqual([
      "mode",
      "model",
      "effort",
      "fast",
    ]);

    await r.worker.hibernate(OWNER);
    expect(r.worker.snapshot().state).toBe("hibernated");

    // The RESUMED process reports a DIFFERENT catalogue — two entries, not four — and one more
    // set answer, so the auto-wake is followed by a real call rather than by a refusal.
    const woken = entriesOf(CLAUDE_SET);
    r.next({ created: CLAUDE_CREATED, resumed: woken, setConfigOption: [{ result: CLAUDE_SET }] });

    const response = await r.worker.setConfig({ configId: "model", value: "haiku" }, OWNER);

    expect(r.worker.snapshot().state).toBe("ready");
    expect(response.stale).toBe(false);
    expect(ids(response.configOptions)).toEqual(["mode", "model"]);
    // Re-seeded BEFORE the set: the delta is measured against the resumed catalogue, so a
    // resumed worker does not report a shrink that happened while it was asleep.
    expect(response.removed).toEqual([]);
    expect(response.added).toEqual([]);

    await r.worker.close("client_request");
  });

  it("a wake whose resume body carries NO catalogue keeps the one we already had", async () => {
    const r = await rig({ agent: { created: CLAUDE_CREATED } });
    await r.worker.hibernate(OWNER);
    r.next({ created: CLAUDE_CREATED, setConfigOption: [{ result: CLAUDE_SET }] });

    await r.worker.wake(OWNER);

    // `withSessionBody` leaves an ABSENT field alone; erasing a catalogue because the resume
    // body did not repeat it would be the same "merge with a guess" §22.2 forbids, inverted.
    expect(ids(r.worker.snapshot().configOptions ?? null)).toEqual([
      "mode",
      "model",
      "effort",
      "fast",
    ]);

    await r.worker.close("client_request");
  });
});
