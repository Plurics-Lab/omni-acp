import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OmniError, type EventEnvelope, type EventInput } from "@omni-acp/protocol";
import { createPersistedEventLog } from "../../src/event-log/sqlite-log.js";
import { SCHEMA_VERSION, migrateTo } from "../../src/persist/schema.js";
import { openDb, rawStore, hasColumn, type RawStore } from "./support/raw-db.js";
import { DAEMON_ID, sqliteConfig, workerId } from "./support/harness.js";

/**
 * Schema v3 (§24.2, review finding V2/V8): ONE nullable column, `workers.m2_json`.
 *
 * `WorkerRow` has carried M2's rows since the Land step and NOT ONE of them was ever written to
 * disk, so the comment on it ("persisted BECAUSE OF THE WAKE PATH") was false and every one of
 * those fields degraded to its M1 default on the first wake after a restart.
 *
 * Unlike v2 this step is not CREATE-only — it is an `alter table` — so the two things that matter
 * are that it is IDEMPOTENT on every open (the guard is `pragma_table_info`, a question about the
 * file rather than a version number) and that it changes nothing else: every M1 event, every v2
 * table, and every other column of `workers` are exactly where they were.
 *
 * Owned by M2-B (review round 2).
 */

const chunk = (text: string): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 1,
  payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

describe("SCHEMA_VERSION 3 (§24.2, review finding V2/V8)", () => {
  it("is 3", () => {
    expect(SCHEMA_VERSION).toBe(3);
  });

  describe("a v2 file opened by this daemon", () => {
    let dir: string;
    let file: string;
    let written: EventEnvelope[];

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "omni-acp-v2-"));
      file = join(dir, "events.db");

      // An M2-round-1 daemon, exactly: `migrateTo(…, 2)` runs its statements and stamps its
      // version, and `workers.m2_json` is ABSENT because a daemon that does not understand a
      // column must not create it.
      const v2 = await rawStore({ dir, file, version: 2 });
      expect(hasColumn(v2.db, "workers", "m2_json")).toBe(false);
      const log = createPersistedEventLog({
        workerId: workerId(1),
        daemonId: DAEMON_ID,
        clock: v2.clock,
        store: v2.events,
        config: sqliteConfig(),
      });
      written = [];
      for (let i = 0; i < 12; i++) written.push(log.append(chunk(`m${String(i)}`)));
      log.flush();
      log.close();
      v2.db.close();
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("adds exactly one column, and every M1 event is still there byte for byte", async () => {
      const v3 = await rawStore({ dir, file });
      try {
        expect(hasColumn(v3.db, "workers", "m2_json")).toBe(true);
        expect(
          Number(
            v3.db.prepare("select value from meta where key = 'schema_version'").get()?.["value"],
          ),
        ).toBe(3);
        expect(v3.events.read(workerId(1), 0, 1_000)).toEqual(written);
        // The v2 tables are untouched, and nothing new appeared beside them.
        expect(tablesOf(v3.db)).toEqual([
          "event_state",
          "events",
          "meta",
          "payloads",
          "runs",
          "webhook_deliveries",
          "workers",
        ]);
      } finally {
        v3.db.close();
      }
    });

    it("is idempotent: the alter is guarded by a QUESTION about the file, not by a version", async () => {
      const again = await rawStore({ dir, file });
      try {
        // Both calls run `applyV3` unconditionally; a second `alter table` would throw
        // "duplicate column name", which is precisely why the guard is `pragma_table_info`.
        expect(migrateTo(again.db, { warn: () => {} }, 3)).toBe(3);
        expect(migrateTo(again.db, { warn: () => {} }, 3)).toBe(3);
        expect(columnsOf(again.db, "workers").filter((c) => c === "m2_json")).toHaveLength(1);
      } finally {
        again.db.close();
      }
    });

    it("changes NO other column of `workers`", async () => {
      const fresh = await mkdtemp(join(tmpdir(), "omni-acp-v2-ddl-"));
      try {
        const v2Db = openDb(join(fresh, "events.db"), 2);
        const before = columnsOf(v2Db, "workers");
        v2Db.close();

        const v3 = await rawStore({ dir, file });
        const after = columnsOf(v3.db, "workers");
        v3.db.close();

        expect(after).toEqual([...before, "m2_json"]);
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
    });
  });

  it("a v3 file opened by an M2-round-1 daemon fails loudly, naming the version", async () => {
    const store = await rawStore();
    try {
      // `migrateTo(db, logger, 2)` IS that daemon — the shipped code path, with the version it
      // understands. Forward-only is not a preference: opening it anyway would write rows that
      // silently drop the column, which is the operator's data lost on a downgrade.
      expect(() => migrateTo(store.db, { warn: () => {} }, 2)).toThrow(
        /schema_version 3 is newer than this daemon understands \(2\)/,
      );
      let code = "no-throw";
      try {
        migrateTo(store.db, { warn: () => {} }, 2);
      } catch (e) {
        code = e instanceof OmniError ? e.code : "not-an-OmniError";
      }
      expect(code).toBe("internal");
      expect(
        Number(
          store.db.prepare("select value from meta where key = 'schema_version'").get()?.["value"],
        ),
      ).toBe(3);
    } finally {
      await store.dispose();
    }
  });
});

function tablesOf(db: RawStore["db"]): string[] {
  return db
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all()
    .map((r) => String(r["name"]))
    .filter((n) => !n.startsWith("sqlite_"));
}

function columnsOf(db: RawStore["db"], table: string): string[] {
  return db
    .prepare("select name from pragma_table_info(?)")
    .all(table)
    .map((r) => String(r["name"]));
}
