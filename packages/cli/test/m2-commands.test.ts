import { describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { parseArgs } from "../src/args.js";
import { renderInteractions, renderWorkers } from "../src/remote.js";
import type { InteractionListResponse, WorkerSnapshot } from "@omni-acp/protocol";

/**
 * M2's four CLI commands (CONTRACTS.md §5.8.10, M2-WP-J acceptance 11):
 *
 *     omni-acp interactions <wid>
 *     omni-acp interactions answer <wid> <reqId> --allow|--deny|--value q=v
 *     omni-acp config <wid> <configId> <value>
 *     omni-acp runs · omni-acp deliveries [--redeliver <id>]
 *
 * Each is `parse → ONE call → print` (D15), and both halves are asserted: the parse against
 * `parseArgs`, and the "ONE call" against a real loopback server that records every request it
 * received — a command that got chatty would show up as a second row in `seen`.
 *
 * Owned by M2-WP-J.
 */

function sink(): {
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };
  out: () => string;
  err: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: { write: (c: string) => ((stdout += c), true) } as unknown as NodeJS.WritableStream,
      stderr: { write: (c: string) => ((stderr += c), true) } as unknown as NodeJS.WritableStream,
    },
    out: () => stdout,
    err: () => stderr,
  };
}

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: string;
}

/** A `/v1` responder that records the METHOD and the BODY, which M1's helper did not need to. */
async function serve(routes: Record<string, unknown>): Promise<{
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const body = routes[`${req.method ?? ""} ${req.url ?? ""}`];
      res.writeHead(body === undefined ? 400 : 200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(body ?? { code: "bad_request", message: `no route for ${req.url ?? ""}` }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const WID = "w_01J00000000000000000000001";
const REQ = "x_01J00000000000000000000001";
const AUTH = ["--token", "secret-token-value"];

describe("parseArgs — M2's four commands", () => {
  it("parses the pending list and the three answer forms", () => {
    expect(parseArgs(["interactions", WID])).toEqual({ cmd: "interactions", workerId: WID });
    expect(parseArgs(["interactions", "answer", WID, REQ, "--allow"])).toEqual({
      cmd: "interactions-answer",
      workerId: WID,
      reqId: REQ,
      answer: { action: "allow" },
    });
    expect(parseArgs(["interactions", "answer", WID, REQ, "--deny"])).toEqual({
      cmd: "interactions-answer",
      workerId: WID,
      reqId: REQ,
      answer: { action: "deny" },
    });
    // Keyed by QUESTION id, and the FIRST `=` splits: a value may contain one, an id may not.
    expect(
      parseArgs(["interactions", "answer", WID, REQ, "--value", "question_0=notes.md"]),
    ).toEqual({
      cmd: "interactions-answer",
      workerId: WID,
      reqId: REQ,
      answer: { action: "answer", content: { question_0: "notes.md" } },
    });
    expect(parseArgs(["interactions", "answer", WID, REQ, "--value", "q=a=b"])).toMatchObject({
      answer: { action: "answer", content: { q: "a=b" } },
    });
  });

  it("refuses an answer that names none of the three, or more than one", () => {
    expect(parseArgs(["interactions", "answer", WID, REQ])).toMatchObject({ cmd: "error" });
    expect(parseArgs(["interactions", "answer", WID, REQ, "--allow", "--deny"])).toMatchObject({
      cmd: "error",
    });
    expect(parseArgs(["interactions", "answer", WID, REQ, "--value", "novalue"])).toMatchObject({
      cmd: "error",
      message: expect.stringContaining("question=value") as unknown as string,
    });
    expect(parseArgs(["interactions", "answer", WID])).toMatchObject({ cmd: "error" });
  });

  it("has NO --allow-always flag: rule 3 makes it a 400 unless the operator opted in (F26)", () => {
    expect(parseArgs(["interactions", "answer", WID, REQ, "--allow-always"])).toMatchObject({
      cmd: "error",
      message: expect.stringContaining("unknown flag") as unknown as string,
    });
  });

  it("parses config, runs and deliveries, and keeps every flag scoped to its command", () => {
    expect(parseArgs(["config", WID, "model", "haiku"])).toEqual({
      cmd: "config",
      workerId: WID,
      configId: "model",
      value: "haiku",
    });
    expect(parseArgs(["config", WID, "model"])).toMatchObject({ cmd: "error" });
    expect(parseArgs(["runs", "--json"])).toEqual({ cmd: "runs", json: true });
    expect(parseArgs(["deliveries", "--redeliver", "dl_1"])).toEqual({
      cmd: "deliveries",
      redeliver: "dl_1",
    });
    // `--redeliver` belongs to `deliveries` alone.
    expect(parseArgs(["runs", "--redeliver", "dl_1"])).toMatchObject({ cmd: "error" });
  });
});

describe("omni-acp interactions / config / runs / deliveries — parse, ONE call, print", () => {
  it("lists the pending set and prints the option IDS, never their names (F27)", async () => {
    const body: InteractionListResponse = {
      interactions: [
        {
          requestId: REQ,
          workerId: WID,
          kind: "permission",
          method: "session/request_permission",
          status: "pending",
          title: "Edit hello.txt",
          message: null,
          turnId: null,
          toolCallId: "toolu_1",
          createdAt: "2026-09-09T00:00:00.000Z",
          options: [
            {
              optionId: "allow",
              name: "Yes, and don't ask again for this file",
              kind: "allow_once",
            },
            { optionId: "reject", name: "No", kind: "reject_once" },
          ],
          fields: [],
          expiresAt: null,
          settledAt: null,
          settledBy: null,
          answer: null,
        },
      ],
    };
    const server = await serve({ [`GET /v1/workers/${WID}/interactions`]: body });
    try {
      const io = sink();
      expect(await main(["interactions", WID, "--url", server.url, ...AUTH], {}, io.io)).toBe(0);
      expect(server.seen).toHaveLength(1);
      expect(io.out()).toContain(REQ);
      expect(io.out()).toContain("allow(allow_once)");
      // F27: one id arrived under three different names, one with a path in it. The id and the
      // kind are the stable fields, and they are the ones printed.
      expect(io.out()).not.toContain("don't ask again");
    } finally {
      await server.close();
    }
  });

  it("answers with exactly one POST carrying the operator's intent, not a chosen option", async () => {
    const server = await serve({
      [`POST /v1/workers/${WID}/interactions/${REQ}`]: {
        interaction: {
          requestId: REQ,
          workerId: WID,
          kind: "permission",
          method: "session/request_permission",
          status: "answered",
          title: "Edit hello.txt",
          message: null,
          turnId: null,
          toolCallId: null,
          createdAt: "2026-09-09T00:00:00.000Z",
          options: [],
          fields: [],
          expiresAt: null,
          settledAt: "2026-09-09T00:00:01.000Z",
          settledBy: "human",
          answer: { optionId: "allow", by: "human" },
        },
        state: "running",
        seq: 12,
      },
    });
    try {
      const io = sink();
      const code = await main(
        ["interactions", "answer", WID, REQ, "--allow", "--url", server.url, ...AUTH],
        {},
        io.io,
      );
      expect(code).toBe(0);
      expect(server.seen).toHaveLength(1);
      expect(server.seen[0]?.method).toBe("POST");
      // The daemon re-checks D4's rules; the CLI sends the intent and never an `optionId` it
      // picked itself (§19.7).
      expect(JSON.parse(server.seen[0]?.body ?? "{}")).toEqual({ action: "allow" });
      expect(io.out()).toContain("answered");
      expect(io.out()).toContain("worker running");
    } finally {
      await server.close();
    }
  });

  it("sets a config option and prints the FULL replacement list plus the delta (F34)", async () => {
    const server = await serve({
      [`POST /v1/workers/${WID}/config`]: {
        configOptions: [
          { id: "mode", currentValue: "default", raw: { name: "Mode" } },
          { id: "model", currentValue: "haiku", raw: { name: "Model" } },
        ],
        removed: ["effort", "fast"],
        added: [],
        stale: false,
      },
    });
    try {
      const io = sink();
      const code = await main(
        ["config", WID, "model", "haiku", "--url", server.url, ...AUTH],
        {},
        io.io,
      );
      expect(code).toBe(0);
      expect(JSON.parse(server.seen[0]?.body ?? "{}")).toEqual({
        configId: "model",
        value: "haiku",
      });
      expect(io.out()).toContain("model");
      expect(io.out()).toContain("haiku");
      // F34's four→two shrink is real, and an operator has to be able to see it.
      expect(io.out()).toContain("removed: effort, fast");
    } finally {
      await server.close();
    }
  });

  it("lists runs and deliveries, and redelivers exactly one", async () => {
    const server = await serve({
      "GET /v1/runs": {
        runs: [
          {
            runId: "r_01J00000000000000000000001",
            daemonId: "d_01J00000000000000000000000",
            state: "succeeded",
            agentId: "example",
            cwd: "/tmp/w",
            workerId: WID,
            turnId: null,
            createdAt: "2026-09-09T00:00:00.000Z",
            updatedAt: "2026-09-09T00:00:05.000Z",
            result: null,
            error: null,
            persistence: "durable",
            webhook: { url: "http://127.0.0.1:9/hook", deliveries: 1 },
          },
        ],
        cursor: null,
      },
      "GET /v1/webhooks/deliveries": {
        deliveries: [
          {
            deliveryId: "dl_01J00000000000000000000001",
            runId: "r_01J00000000000000000000001",
            event: "run.completed",
            state: "failed",
            attempt: 6,
            nextAttemptAt: null,
            lastStatus: 500,
            lastError: "receiver said 500",
            responseMs: 12,
            createdAt: "2026-09-09T00:00:00.000Z",
            updatedAt: "2026-09-09T00:10:00.000Z",
          },
        ],
        cursor: null,
      },
      "POST /v1/webhooks/deliveries/dl_01J00000000000000000000001/redeliver": {
        deliveryId: "dl_01J00000000000000000000001",
        runId: "r_01J00000000000000000000001",
        event: "run.completed",
        state: "pending",
        attempt: 6,
        nextAttemptAt: "2026-09-09T00:11:00.000Z",
        lastStatus: 500,
        lastError: null,
        responseMs: null,
        createdAt: "2026-09-09T00:00:00.000Z",
        updatedAt: "2026-09-09T00:11:00.000Z",
      },
    });
    try {
      let io = sink();
      expect(await main(["runs", "--url", server.url, ...AUTH], {}, io.io)).toBe(0);
      expect(io.out()).toContain("succeeded");
      expect(io.out()).toContain("1 to http://127.0.0.1:9/hook");

      io = sink();
      expect(await main(["deliveries", "--url", server.url, ...AUTH], {}, io.io)).toBe(0);
      expect(io.out()).toContain("failed");
      expect(io.out()).toContain("receiver said 500");

      io = sink();
      const code = await main(
        [
          "deliveries",
          "--redeliver",
          "dl_01J00000000000000000000001",
          "--url",
          server.url,
          ...AUTH,
        ],
        {},
        io.io,
      );
      expect(code).toBe(0);
      // The dead-letter queue's ONE verb: a redeliver is a POST for that id and nothing else.
      expect(server.seen.at(-1)?.method).toBe("POST");
      expect(io.out()).toContain("pending");
    } finally {
      await server.close();
    }
  });

  it("reports the daemon's own sentence and exits 1, never a stack", async () => {
    const server = await serve({});
    try {
      const io = sink();
      const code = await main(["runs", "--url", server.url, ...AUTH], {}, io.io);
      expect(code).toBe(1);
      expect(io.err()).toContain("omni-acp:");
      expect(io.err()).not.toContain("at Object");
    } finally {
      await server.close();
    }
  });
});

describe("omni-acp workers — requires_action and the pending count (acceptance 11)", () => {
  const base = {
    daemonId: "d_01J00000000000000000000000",
    ref: "d_01J00000000000000000000000:w_01J00000000000000000000001",
    sessionId: "s1",
    cwd: "/tmp/w",
    label: null,
    ownerTokenId: "local",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    headSeq: 4,
    currentTurnId: null,
    capabilities: null,
    closeReason: null,
    lease: { holder: null, epoch: 0, expiresAt: null, pinned: false },
    hibernatedAt: null,
    crashed: false,
    resume: null,
    wakeCount: 0,
    wakeFailures: 0,
    orphan: null,
    generation: 1,
    runtimeId: "example@abcdef012345",
    persistence: "memory" as const,
  };

  it("prints the state and how many interactions are waiting for a human", () => {
    const parked = {
      ...base,
      workerId: "w_01J00000000000000000000001",
      agentId: "example",
      state: "requires_action" as const,
      process: { pid: 4242, startedAt: "2026-01-01T00:00:00.000Z" },
      interactions: [{ requestId: REQ }],
    } as unknown as WorkerSnapshot;
    const idle = {
      ...base,
      workerId: "w_01J00000000000000000000002",
      agentId: "example",
      state: "ready" as const,
      process: { pid: 4243, startedAt: "2026-01-01T00:00:00.000Z" },
      interactions: [],
    } as unknown as WorkerSnapshot;

    const table = renderWorkers([parked, idle], {});
    expect(table).toContain("PENDING");
    expect(table).toContain("requires_action");
    // §19.5's invariant, visible in two columns: non-empty pending ⟺ `requires_action`.
    const rows = table.split("\n");
    expect(rows[1]).toMatch(/requires_action.*\s1\s/);
    expect(rows[2]).toMatch(/ready.*\s0\s/);
  });

  it("an M1 snapshot with no `interactions` row prints 0 rather than breaking", () => {
    const m1 = { ...base, workerId: WID, agentId: "example", state: "ready", process: null };
    expect(renderWorkers([m1 as unknown as WorkerSnapshot], {})).toContain("0");
  });
});

describe("renderInteractions", () => {
  it("says so when nothing is pending, rather than printing an empty table", () => {
    expect(renderInteractions({ interactions: [] })).toBe("no pending interactions");
  });
});
