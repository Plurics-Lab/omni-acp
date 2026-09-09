import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OmniError, type EventEnvelope, type WorkerId } from "@omni-acp/protocol";
import { createSqliteEventStore } from "../../src/persist/event-store.js";
import { SCHEMA_VERSION, migrate } from "../../src/persist/schema.js";
import { workerId } from "./support/harness.js";
import { rawStore, type RawStore } from "./support/raw-db.js";

const DAEMON = `d_${"0".repeat(25)}7`;
const TS = "2026-02-01T00:00:00.000Z";

/**
 * `seq: n` here is a COPY of a number this test chose, not an invention by the store: §5.1 is
 * explicit that "nothing here assigns a `seq` — the store is TOLD what it is", and testing
 * `EventStore` without saying which seq is being stored is not possible.
 */
function envelope(w: WorkerId, n: number, over: Partial<EventEnvelope> = {}): EventEnvelope {
  return Object.freeze({
    seq: n,
    ts: TS,
    daemonId: DAEMON,
    workerId: w,
    sessionId: null,
    turnId: null,
    payloadVersion: 1,
    kind: "acp.session_update",
    payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `m${n}` } },
    ...over,
  }) as unknown as EventEnvelope;
}

describe("createSqliteEventStore (§14.3, §14.4, §14.6, §14.7)", () => {
  let raw: RawStore;
  const W = workerId(1);

  beforeEach(async () => {
    raw = await rawStore();
  });

  afterEach(async () => {
    await raw.dispose();
  });

  it("starts a worker it has never seen at head 0, tail 1", () => {
    expect(raw.events.headOf(W)).toBe(0);
    expect(raw.events.tailOf(W)).toBe(1);
    expect(raw.events.read(W, 0, 10)).toEqual([]);
    expect(raw.events.seqAtOffset(W, 0)).toBeNull();
    expect(raw.events.workersWithEvents()).toEqual([]);
  });

  it("round-trips every envelope field, including an absent `replay`", () => {
    const plain = envelope(W, 1);
    const rich = envelope(W, 2, {
      sessionId: "sess-1",
      turnId: `t_${"0".repeat(25)}1`,
      replay: true,
      payloadVersion: 2,
      kind: "omni.error",
      payload: { code: "agent_error", message: "the agent said no" },
    } as Partial<EventEnvelope>);
    raw.events.put(plain);
    raw.events.put(rich);

    const [a, b] = raw.events.read(W, 0, 10);
    expect(a).toEqual(plain);
    expect(b).toEqual(rich);
    // Absent, not `false`: `EventInput.replay` is `true | undefined`, and a `replay: false` key
    // would make a round-tripped envelope un-deep-equal to the one that was appended.
    expect(Object.hasOwn(a as object, "replay")).toBe(false);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("is an EXCLUSIVE lower bound with a limit, ascending", () => {
    for (let i = 1; i <= 10; i++) raw.events.put(envelope(W, i));
    expect(raw.events.read(W, 0, 3).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(raw.events.read(W, 7, 100).map((e) => e.seq)).toEqual([8, 9, 10]);
    expect(raw.events.read(W, 10, 100)).toEqual([]);
    expect(raw.events.read(W, 0, 0)).toEqual([]);
  });

  it("keeps two workers' sequences apart", () => {
    const other = workerId(2);
    for (let i = 1; i <= 5; i++) raw.events.put(envelope(W, i));
    for (let i = 1; i <= 2; i++) raw.events.put(envelope(other, i));

    expect(raw.events.headOf(W)).toBe(5);
    expect(raw.events.headOf(other)).toBe(2);
    expect(raw.events.read(other, 0, 10).map((e) => e.seq)).toEqual([1, 2]);
    expect([...raw.events.workersWithEvents()].sort()).toEqual([W, other].sort());
  });

  it("REFUSES a second writer at the same (worker_id, seq) — §14.7's backstop", () => {
    raw.events.put(envelope(W, 1));
    // Two daemons assigning from their own head collide here, loudly, instead of silently
    // forking one worker's history.
    expect(() => raw.events.put(envelope(W, 1))).toThrow();
    expect(raw.events.diagnostics.writeFailures).toBe(1);
    expect(raw.events.read(W, 0, 10)).toHaveLength(1);
  });

  it("counts every write failure into diagnostics and rethrows", () => {
    expect(raw.events.diagnostics).toMatchObject({
      driver: "sqlite",
      schemaVersion: SCHEMA_VERSION,
      writeFailures: 0,
    });
    expect(raw.events.diagnostics.file).toBe(raw.file);
    expect(raw.events.diagnostics.sizeBytes).toBeGreaterThan(0);

    raw.events.put(envelope(W, 1));
    for (let i = 0; i < 3; i++) expect(() => raw.events.put(envelope(W, 1))).toThrow();
    expect(raw.events.diagnostics.writeFailures).toBe(3);
  });

  it("seqAtOffset walks the retained rows without DELETE … LIMIT", () => {
    for (let i = 1; i <= 10; i++) raw.events.put(envelope(W, i));
    expect(raw.events.seqAtOffset(W, 0)).toBe(1);
    expect(raw.events.seqAtOffset(W, 4)).toBe(5);
    expect(raw.events.seqAtOffset(W, 9)).toBe(10);
    expect(raw.events.seqAtOffset(W, 10)).toBeNull();
    expect(raw.events.seqAtOffset(W, -1)).toBeNull();

    raw.events.evict(W, 3);
    // The offset is into what is RETAINED, which is what makes it the row-cap sweep's cursor.
    expect(raw.events.seqAtOffset(W, 0)).toBe(4);
  });

  describe("head restoration across a reopen (§14.4)", () => {
    it("restores from max(seq) when the rows are still there", () => {
      for (let i = 1; i <= 300; i++) raw.events.put(envelope(W, i));
      raw.reopen();
      expect(raw.events.headOf(W)).toBe(300);
      expect(raw.events.tailOf(W)).toBe(1);
    });

    it("restores from the durable head_seq when retention has taken every row", () => {
      for (let i = 1; i <= 300; i++) raw.events.put(envelope(W, i));
      expect(raw.events.evict(W, 300)).toBe(300);
      raw.reopen();
      // `max(seq)` is NULL here. A restore that trusted it would say 0 and re-issue seq 1.
      expect(raw.events.headOf(W)).toBe(300);
      expect(raw.events.tailOf(W)).toBe(301);
      expect(raw.events.read(W, 0, 10)).toEqual([]);
    });

    it("survives a close with fewer appends than the debounce window", () => {
      // §14.4's debounce is every 256 appends or 5 s; `flush()` is what makes the tail of that
      // window durable, and `PersistenceHandle.close()` calls it. Five appends never trip the
      // counter, so without the flush the `head_seq` column would still be 0 here.
      for (let i = 1; i <= 5; i++) raw.events.put(envelope(W, i));
      raw.events.flush();
      expect(raw.events.evict(W, 5)).toBe(5);
      raw.reopen();
      expect(raw.events.headOf(W)).toBe(5);
      expect(raw.events.tailOf(W)).toBe(6);
    });
  });

  describe("the digest side table (§14.6)", () => {
    const big = (tag: string): EventEnvelope["payload"] =>
      ({
        sessionUpdate: "available_commands_update",
        availableCommands: Array.from({ length: 40 }, (_, i) => ({
          name: `${tag}-${i}`,
          description: "d".repeat(200),
        })),
      }) as unknown as EventEnvelope["payload"];

    it("stores one row per DISTINCT payload and rehydrates it transparently", () => {
      const a = big("a");
      const b = big("b");
      for (let i = 1; i <= 20; i++) {
        raw.events.put(envelope(W, i, { payload: i % 2 === 0 ? a : b }));
      }
      expect(raw.events.payloadCount()).toBe(2);

      const read = raw.events.read(W, 0, 100);
      expect(read).toHaveLength(20);
      // Every reader sees the identical payload it would have seen with no digest at all.
      for (const [i, e] of read.entries()) {
        expect(JSON.stringify(e.payload)).toBe(JSON.stringify((i + 1) % 2 === 0 ? a : b));
      }
    });

    it("leaves a small payload inline — a second table row would cost more than it saves", () => {
      raw.events.put(envelope(W, 1));
      expect(raw.events.payloadCount()).toBe(0);
      const row = raw.db.prepare("select payload, digest_ref from events where seq = 1").get();
      expect(row?.["digest_ref"]).toBeNull();
      expect(String(row?.["payload"])).toContain("agent_message_chunk");
    });

    it("refcounts, so evicting one worker does not blank another's payload", () => {
      const other = workerId(3);
      const shared = big("shared");
      for (let i = 1; i <= 5; i++) raw.events.put(envelope(W, i, { payload: shared }));
      for (let i = 1; i <= 5; i++) raw.events.put(envelope(other, i, { payload: shared }));
      expect(raw.events.payloadCount()).toBe(1);

      raw.events.evict(W, 5);
      // Still referenced by the other worker: a naive "delete the payload with the events" would
      // have made that worker's history unreadable.
      expect(raw.events.payloadCount()).toBe(1);
      expect(JSON.stringify(raw.events.read(other, 0, 10)[0]?.payload)).toBe(
        JSON.stringify(shared),
      );

      raw.events.evict(other, 5);
      // Nothing references it now, so it goes.
      expect(raw.events.payloadCount()).toBe(0);
    });

    it("honours an injected digest rule, which is where a descriptor plugs in", () => {
      // `EventStore.put` is handed an envelope and nothing else, so the store applies §14.6 by
      // payload size — but the rule is a parameter, which is the seam a resolved descriptor's
      // `UpdateRule.digest` plugs into once WP-E can hand one down.
      const empty = {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      } as unknown as EventEnvelope["payload"];
      const byKind = createSqliteEventStore(raw.db, {
        clock: raw.clock,
        file: raw.file,
        digest: (e) =>
          (e.payload as { sessionUpdate?: string } | null)?.sessionUpdate ===
          "available_commands_update",
      });
      const other = workerId(4);

      // Small, but the rule says digest it.
      byKind.put(envelope(other, 1, { payload: empty }));
      expect(byKind.payloadCount()).toBe(1);
      // Large — far past the default size threshold — but the rule says do not.
      const chatty = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x".repeat(20_000) },
      } as unknown as EventEnvelope["payload"];
      byKind.put(envelope(other, 2, { payload: chatty }));
      expect(byKind.payloadCount()).toBe(1);

      expect(byKind.read(other, 0, 10).map((e) => JSON.stringify(e.payload))).toEqual([
        JSON.stringify(empty),
        JSON.stringify(chatty),
      ]);
    });
  });

  it("evict is a no-op below the current tail and never lowers it", () => {
    for (let i = 1; i <= 10; i++) raw.events.put(envelope(W, i));
    expect(raw.events.evict(W, 5)).toBe(5);
    expect(raw.events.tailOf(W)).toBe(6);
    expect(raw.events.evict(W, 3)).toBe(0);
    expect(raw.events.tailOf(W)).toBe(6);
    expect(raw.events.evict(W, Number.NaN)).toBe(0);
    expect(raw.events.tailOf(W)).toBe(6);
  });

  it("wraps a failed eviction in an OmniError rather than leaking a sqlite one", () => {
    for (let i = 1; i <= 3; i++) raw.events.put(envelope(W, i));
    raw.db.exec(
      "create trigger block before delete on events begin select raise(abort, 'nope'); end",
    );
    expect(() => raw.events.evict(W, 2)).toThrow(OmniError);
    raw.db.exec("drop trigger block");
    expect(raw.events.read(W, 0, 10)).toHaveLength(3);
  });
});

describe("migrate (§14.7)", () => {
  it("creates the schema, records the version, and is idempotent", async () => {
    const raw = await rawStore();
    try {
      expect(migrate(raw.db, { warn: () => {} })).toBe(SCHEMA_VERSION);
      const tables = raw.db
        .prepare("select name from sqlite_master where type = 'table' order by name")
        .all()
        .map((r) => String(r["name"]));
      // Schema v2 adds `runs` and `webhook_deliveries` and touches nothing else (§24.2). The list
      // is exhaustive on purpose: a table that appeared without a decision behind it shows up
      // here rather than in production.
      expect(tables).toEqual([
        "event_state",
        "events",
        "meta",
        "payloads",
        "runs",
        "webhook_deliveries",
        "workers",
      ]);
      // `WITHOUT ROWID` on `(worker_id, seq)`: the only access pattern is a clustered prefix
      // scan, and the primary key doubles as the second-daemon backstop.
      const ddl = String(
        raw.db.prepare("select sql from sqlite_master where name = 'events'").get()?.["sql"],
      );
      expect(ddl).toContain("primary key (worker_id, seq)");
      expect(ddl.toLowerCase()).toContain("without rowid");
    } finally {
      await raw.dispose();
    }
  });

  it("REFUSES a file written by a newer daemon, naming both versions", async () => {
    const raw = await rawStore();
    try {
      raw.db
        .prepare("update meta set value = ? where key = 'schema_version'")
        .run(String(SCHEMA_VERSION + 5));
      // Never a silent downgrade: opening it anyway would write rows that quietly drop whatever
      // columns the newer schema added.
      expect(() => migrate(raw.db, { warn: () => {} })).toThrow(
        new RegExp(`${SCHEMA_VERSION + 5}.*${SCHEMA_VERSION}`),
      );
    } finally {
      await raw.dispose();
    }
  });

  it("rewrites an unreadable version rather than guessing what to migrate FROM", async () => {
    const raw = await rawStore();
    try {
      raw.db.prepare("update meta set value = 'banana' where key = 'schema_version'").run();
      const warnings: string[] = [];
      expect(migrate(raw.db, { warn: (m) => warnings.push(m) })).toBe(SCHEMA_VERSION);
      expect(warnings.join(" ")).toContain("unreadable");
    } finally {
      await raw.dispose();
    }
  });
});
