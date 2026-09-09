import { describe, expect, it } from "vitest";
import {
  OmniError,
  type ConfigOptionView,
  type DaemonId,
  type SetConfigResponse,
  type TokenId,
  type WorkerId,
  type WorkerSnapshot,
} from "@omni-acp/protocol";
import { createConfigChannel } from "../src/config.js";
import type { Transport } from "../src/transport.js";
import { createWorkerHandle } from "../src/worker.js";

/**
 * `worker.setConfig()` / `worker.config` (§5.8.10, §22.2's SDK row).
 *
 * The whole design is one sentence: the cached list moves SYNCHRONOUSLY with the promise's
 * resolution and never from the event stream, because neither real agent emits a
 * `config_option_update` for a set (F34, F35) — a channel that waited for one would wait for
 * ever. The second half is the mirror image: a failed set leaves the cached list UNCHANGED,
 * because a half-updated snapshot is worse than a stale one.
 *
 * `createConfigChannel` is not on the frozen barrel — only the `Worker` TYPE is — so it is
 * reached the way `worker.ts` reaches it, by module path.
 *
 * Owned by M2-A-WP-C.
 */

const WID = "w_00000000000000000000000001" as WorkerId;
const DID = "d_00000000000000000000000001" as DaemonId;

const option = (id: string, currentValue: unknown): ConfigOptionView => ({
  id,
  currentValue,
  raw: { id, currentValue, name: id, type: "select" },
});

/** claude `15`, before and after — the 4 → 2 shrink, as the SDK sees it. */
const FOUR: readonly ConfigOptionView[] = [
  option("mode", "default"),
  option("model", "default"),
  option("effort", "default"),
  option("fast", "off"),
];
const TWO: readonly ConfigOptionView[] = [option("mode", "default"), option("model", "haiku")];

const answer = (o: Partial<SetConfigResponse>): SetConfigResponse => ({
  configOptions: TWO,
  removed: ["effort", "fast"],
  added: [],
  stale: false,
  ...o,
});

interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

/** A transport that records the request and answers with whatever the test queued. */
function recordingTransport(answers: unknown[]): { transport: Transport; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const transport: Transport = {
    clientId: "cli_a",
    leaseEpoch: null,
    adoptLeaseEpoch: () => {},
    request: <R>(method: string, path: string, body?: unknown): Promise<R> => {
      calls.push({ method, path, body });
      const next = answers.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next as R);
    },
    open: () => Promise.reject(new Error("not used")),
  };
  return { transport, calls };
}

describe("ConfigChannel — one POST, and the list moves with the promise", () => {
  it("POSTs {configId, value} to /v1/workers/{wid}/config and returns the daemon's list", async () => {
    const { transport, calls } = recordingTransport([answer({})]);
    const channel = createConfigChannel(transport, WID, () => FOUR);

    const returned = await channel.set("model", "haiku");

    expect(calls).toEqual([
      {
        method: "POST",
        path: `/v1/workers/${WID}/config`,
        body: { configId: "model", value: "haiku" },
      },
    ]);
    expect(returned).toEqual(TWO);
  });

  it("`options` reads the SEED until something is set, then the answer — no round trip either way", async () => {
    const { transport, calls } = recordingTransport([answer({})]);
    let seed: readonly ConfigOptionView[] | null = FOUR;
    const channel = createConfigChannel(transport, WID, () => seed);

    // Before any set: the snapshot's own catalogue, read LIVE through the closure rather than
    // copied at construction — the handle is built before its first snapshot refresh.
    expect(channel.options).toEqual(FOUR);
    seed = [option("mode", "plan")];
    expect(channel.options).toEqual([option("mode", "plan")]);
    expect(calls).toHaveLength(0);

    await channel.set("model", "haiku");

    // SYNCHRONOUS with the resolution: the very next read sees it, with no second request.
    expect(channel.options).toEqual(TWO);
    expect(calls).toHaveLength(1);
  });

  it("membership can SHRINK, and the channel reports the shrink rather than merging it away", async () => {
    const { transport } = recordingTransport([answer({})]);
    const channel = createConfigChannel(transport, WID, () => FOUR);

    expect(channel.options?.map((o) => o.id)).toEqual(["mode", "model", "effort", "fast"]);
    await channel.set("model", "haiku");
    // F34: Haiku exposes no effort levels. A channel that merged by id would leave a control the
    // agent now refuses on `worker.config` for ever.
    expect(channel.options?.map((o) => o.id)).toEqual(["mode", "model"]);
  });

  it("a null seed and no set is a null `options` — `null` is a real answer, not an empty list", async () => {
    const { transport } = recordingTransport([
      answer({ configOptions: [], removed: [], added: [] }),
    ]);
    const channel = createConfigChannel(transport, WID, () => null);

    expect(channel.options).toBeNull();
    await channel.set("model", "haiku");
    // …and an agent that really does offer nothing now is `[]`, which is NOT null.
    expect(channel.options).toEqual([]);
  });

  it("`stale: true` still moves the cache — the daemon KEPT the previous list, so it is the truth", async () => {
    const { transport } = recordingTransport([
      answer({ configOptions: FOUR, removed: [], added: [], stale: true }),
    ]);
    const channel = createConfigChannel(transport, WID, () => FOUR);

    const returned = await channel.set("mode", "plan");
    expect(returned).toEqual(FOUR);
    expect(channel.options).toEqual(FOUR);
  });

  it("passes a number and a boolean through unchanged", async () => {
    const { transport, calls } = recordingTransport([answer({}), answer({})]);
    const channel = createConfigChannel(transport, WID, () => null);
    await channel.set("temperature", 0.5);
    await channel.set("fast", true);
    expect(calls.map((c) => c.body)).toEqual([
      { configId: "temperature", value: 0.5 },
      { configId: "fast", value: true },
    ]);
  });
});

describe("ConfigChannel — a failed set leaves `worker.config` UNCHANGED", () => {
  const failures: { name: string; error: Error }[] = [
    { name: "a 503 / network failure", error: new Error("fetch failed") },
    { name: "a 409 worker_busy", error: new OmniError("worker_busy", "a turn is live") },
    { name: "a 423 lease_held", error: new OmniError("lease_held", "another client holds it") },
    {
      name: "a 502 agent_error carrying the agent's -32603",
      error: new OmniError("agent_error", "bad value", {
        acp: {
          code: -32603,
          message: "Internal error",
          data: { details: "Invalid value for config option model: no-such-model-xyz" },
        },
      }),
    },
  ];

  for (const row of failures) {
    it(`${row.name} rejects and the cached list is untouched`, async () => {
      const { transport } = recordingTransport([answer({}), row.error]);
      const channel = createConfigChannel(transport, WID, () => FOUR);

      // One SUCCESSFUL set first, so the assertion is about a cache that has actually moved
      // rather than about a channel that never held anything.
      await channel.set("model", "haiku");
      expect(channel.options).toEqual(TWO);

      await expect(channel.set("model", "no-such-model-xyz")).rejects.toThrow();

      expect(channel.options).toEqual(TWO);
    });
  }

  it("the error reaches the caller with its code intact — the channel never swallows or retries", async () => {
    const { transport, calls } = recordingTransport([
      new OmniError("agent_error", "bad value", {
        acp: { code: -32603, message: "Internal error" },
      }),
    ]);
    const channel = createConfigChannel(transport, WID, () => FOUR);

    const failure = await channel
      .set("model", "no-such-model-xyz")
      .then(() => null)
      .catch((e: unknown) => e);

    expect(OmniError.is(failure, "agent_error")).toBe(true);
    expect((failure as OmniError).acp?.code).toBe(-32603);
    // A silent retry would send a second set the caller never asked for.
    expect(calls).toHaveLength(1);
  });

  it("a 200 whose body carries no configOptions is refused, and the cache does not move", async () => {
    // The one failure the transport cannot classify for us: a well-formed HTTP answer whose body
    // this SDK cannot read. Caching `undefined` and reporting it as the agent's catalogue would
    // be strictly worse than saying so.
    const { transport } = recordingTransport([{ removed: [], added: [], stale: false }]);
    const channel = createConfigChannel(transport, WID, () => FOUR);

    await expect(channel.set("model", "haiku")).rejects.toMatchObject({ code: "internal" });
    expect(channel.options).toEqual(FOUR);
  });
});

// ── the frozen delegation in `client/src/worker.ts` ──────────────────────────

const snapshotOf = (o: Partial<WorkerSnapshot>): WorkerSnapshot =>
  ({
    workerId: WID,
    daemonId: DID,
    ref: `${DID}:${WID}`,
    sessionId: "sess-1",
    agentId: "example",
    state: "ready",
    cwd: "/work",
    label: null,
    ownerTokenId: "tok_a" as TokenId,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    headSeq: 2,
    currentTurnId: null,
    capabilities: null,
    process: null,
    closeReason: null,
    lease: {
      workerId: WID,
      holder: { tokenId: "tok_a" as TokenId, clientId: "cli_a" },
      epoch: 1,
      expiresAt: null,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      pinned: false,
    },
    ...o,
  }) as unknown as WorkerSnapshot;

describe("Worker.setConfig / Worker.config — the handle's three delegating members", () => {
  it("`worker.config` is the snapshot's catalogue until a set, and the set's answer afterwards", async () => {
    const { transport, calls } = recordingTransport([answer({})]);
    const worker = createWorkerHandle(
      transport,
      snapshotOf({ configOptions: FOUR } as Partial<WorkerSnapshot>),
    );

    expect(worker.config).toEqual(FOUR);

    const returned = await worker.setConfig("model", "haiku");

    expect(returned).toEqual(TWO);
    // SYNCHRONOUS with the promise: no notification wait, no second round trip (§22.2's SDK row).
    expect(worker.config).toEqual(TWO);
    expect(calls).toEqual([
      {
        method: "POST",
        path: `/v1/workers/${WID}/config`,
        body: { configId: "model", value: "haiku" },
      },
    ]);
  });

  it("`worker.config` is null for a snapshot that carries no catalogue at all", () => {
    const { transport } = recordingTransport([]);
    const worker = createWorkerHandle(transport, snapshotOf({}));
    // The M2 rows on `WorkerSnapshot` are OPTIONAL (M2-PLAN §1.2 Land note S4): a worker whose
    // agent never offered a catalogue has no key, and `null` is the honest answer.
    expect(worker.config).toBeNull();
  });

  it("a failed set leaves `worker.config` on the last thing that was true", async () => {
    const { transport } = recordingTransport([new OmniError("worker_busy", "a turn is live")]);
    const worker = createWorkerHandle(
      transport,
      snapshotOf({ configOptions: FOUR } as Partial<WorkerSnapshot>),
    );

    await expect(worker.setConfig("model", "haiku")).rejects.toMatchObject({ code: "worker_busy" });
    expect(worker.config).toEqual(FOUR);
  });
});
