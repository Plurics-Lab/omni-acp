import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OmniError, type EventEnvelope, type EventInput } from "@omni-acp/protocol";
import { nullLogger, runEventLogPersistenceConformance } from "@omni-acp/testkit";
import { createPersistedEventLog } from "../../src/event-log/sqlite-log.js";
import { SCHEMA_VERSION, migrateTo } from "../../src/persist/schema.js";
import { openDb, rawStore, type RawStore } from "./support/raw-db.js";
import { DAEMON_ID, makeTmpPersistence, sqliteConfig, workerId } from "./support/harness.js";

/**
 * Schema v2 is CREATE-only: `runs` and `webhook_deliveries` are added and nothing M1 wrote is
 * touched. The direction that matters is BACKWARD: a v2 file opened by an M1 daemon must still
 * fail loudly naming the version, rather than reading rows it does not understand.
 *
 * Owned by M2-B-WP-R.
 */

const chunk = (text: string): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 1,
  payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

/** The exact tables and indexes v2 adds. Anything else appearing here is a decision nobody made. */
const V2_TABLES = ["runs", "webhook_deliveries"];

describe("SCHEMA_VERSION 2 (§14.11, §24.2)", () => {
  it("is 2", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  describe("a v1 file opened by an M2 daemon", () => {
    let dir: string;
    let file: string;
    let written: EventEnvelope[];

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "omni-acp-v1-"));
      file = join(dir, "events.db");

      // ── An M1 daemon, exactly: `migrateTo(…, 1)` runs M1's statements and stamps M1's version,
      //    and the v2 tables are ABSENT because a daemon that does not understand a table must
      //    not create it.
      const m1 = await rawStore({ dir, file, version: 1 });
      expect(
        Number(
          m1.db.prepare("select value from meta where key = 'schema_version'").get()?.["value"],
        ),
      ).toBe(1);
      const before = tablesOf(m1.db);
      expect(before).not.toContain("runs");
      expect(before).not.toContain("webhook_deliveries");

      // M1's events, written through M1's schema by M1's own log.
      const log = createPersistedEventLog({
        workerId: workerId(1),
        daemonId: DAEMON_ID,
        clock: m1.clock,
        store: m1.events,
        config: sqliteConfig(),
      });
      written = [];
      for (let i = 0; i < 40; i++) written.push(log.append(chunk(`m${String(i)}`)));
      log.flush();
      log.close();
      m1.db.close();
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("migrates forward keeping EVERY M1 event, byte for byte", async () => {
      const m2 = await rawStore({ dir, file });
      try {
        const w = workerId(1);
        const read = m2.events.read(w, 0, 1_000);
        expect(read).toHaveLength(40);
        // Deep-equal, not "the right number": a CREATE-only migration that quietly reshaped a
        // payload would still count to 40.
        expect(read).toEqual(written);
        expect(m2.events.headOf(w)).toBe(40);
        expect(m2.events.tailOf(w)).toBe(1);
        // `seq` continues rather than restarting — §14.4's whole point, unaffected by v2.
        const log = createPersistedEventLog({
          workerId: w,
          daemonId: DAEMON_ID,
          clock: m2.clock,
          store: m2.events,
          config: sqliteConfig(),
        });
        expect(log.append(chunk("after")).seq).toBe(41);
        log.flush();
        log.close();
      } finally {
        m2.db.close();
      }
    });

    it("adds exactly two tables and rewrites the version to 2", async () => {
      const m2 = await rawStore({ dir, file });
      try {
        expect(
          Number(
            m2.db.prepare("select value from meta where key = 'schema_version'").get()?.["value"],
          ),
        ).toBe(2);
        const tables = tablesOf(m2.db);
        for (const t of V2_TABLES) expect(tables).toContain(t);
        expect(tables).toEqual([
          "event_state",
          "events",
          "meta",
          "payloads",
          "runs",
          "webhook_deliveries",
          "workers",
        ]);
      } finally {
        m2.db.close();
      }
    });

    it("changes NO column of the M1 tables", async () => {
      // The claim §24.2 makes, checked against the file rather than against the prose: the four
      // M1 tables' DDL is byte-identical to what an M1 daemon would have created.
      const fresh = await mkdtemp(join(tmpdir(), "omni-acp-v1-ddl-"));
      try {
        const v1Db = openDb(join(fresh, "events.db"), 1);
        const v1Ddl = ddlOf(v1Db, ["meta", "workers", "events", "payloads", "event_state"]);
        v1Db.close();

        const m2 = await rawStore({ dir, file });
        const v2Ddl = ddlOf(m2.db, ["meta", "workers", "events", "payloads", "event_state"]);
        m2.db.close();

        expect(v2Ddl).toEqual(v1Ddl);
      } finally {
        await rm(fresh, { recursive: true, force: true });
      }
    });

    it("is idempotent — opening it again is a no-op", async () => {
      const again = await rawStore({ dir, file });
      try {
        expect(migrateTo(again.db, { warn: () => {} }, 2)).toBe(2);
        expect(migrateTo(again.db, { warn: () => {} }, 2)).toBe(2);
        expect(again.events.read(workerId(1), 0, 1_000).length).toBeGreaterThanOrEqual(40);
      } finally {
        again.db.close();
      }
    });
  });

  it("a v2 file opened by an M1 daemon fails loudly, naming the version", async () => {
    const store = await rawStore();
    try {
      // `migrateTo(db, logger, 1)` IS an M1 daemon — the shipped code path, with the version that
      // daemon understands. Not a copy of the check in a test, which is the copy that keeps
      // passing after the original changes.
      expect(() => migrateTo(store.db, { warn: () => nullLogger() }, 1)).toThrow(
        /schema_version 2 is newer than this daemon understands \(1\)/,
      );
      let code = "no-throw";
      try {
        migrateTo(store.db, { warn: () => {} }, 1);
      } catch (e) {
        code = e instanceof OmniError ? e.code : "not-an-OmniError";
      }
      expect(code).toBe("internal");
      // ...and it refused rather than downgrading: the version on disk is untouched.
      expect(
        Number(
          store.db.prepare("select value from meta where key = 'schema_version'").get()?.["value"],
        ),
      ).toBe(2);
    } finally {
      await store.dispose();
    }
  });
});

/**
 * §14.11's conformance suite, run VERBATIM against the v2 schema.
 *
 * This is bullet 1's real assertion and it is deliberately not paraphrased: `tmpPersistence` now
 * opens a v2 file, and M1's persistence suite — head/tail restoration, `seq` continuity across an
 * evict-everything, `_meta` byte fidelity, the degraded-store path, the latency budget, the digest
 * round-trip — runs against it unedited. If the migration had touched one M1 column, this would go
 * red without anybody having to think of the case.
 */
runEventLogPersistenceConformance("sqlite(file), schema v2", makeTmpPersistence);

function tablesOf(db: RawStore["db"]): string[] {
  return db
    .prepare("select name from sqlite_master where type = 'table' order by name")
    .all()
    .map((r) => String(r["name"]))
    .filter((n) => !n.startsWith("sqlite_"));
}

function ddlOf(db: RawStore["db"], names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    out[name] = String(
      db.prepare("select sql from sqlite_master where name = ?").get(name)?.["sql"],
    );
  }
  return out;
}
