import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  EventEnvelope,
  EventInput,
  EventLog,
  NormalizedSessionUpdate,
  Seq,
  TurnId,
  WorkerId,
} from "@omni-acp/protocol";
import type { TmpPersistence, tmpPersistence } from "./tmp-persistence.js";

const TURN_A = `t_${"0".repeat(25)}1` as TurnId;
const TURN_B = `t_${"0".repeat(25)}2` as TurnId;

/**
 * The same escape hatch M0's suites use for shared CI hardware: `OMNI_TEST_SLOW_FACTOR=4` widens
 * every timing budget without weakening what is asserted.
 */
const SLOW = Number(process.env["OMNI_TEST_SLOW_FACTOR"] ?? "1");

const chunk = (text: string, turnId: TurnId | null): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 1,
  turnId,
  payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});

const seqs = (envelopes: readonly EventEnvelope[]): Seq[] => envelopes.map((e) => e.seq);

const isGapFree = (values: readonly number[]): boolean =>
  values.every((v, i) => i === 0 || v === (values[i - 1] ?? 0) + 1);

/**
 * The suite M1's SQLite driver must pass verbatim. Call inside a describe block.
 *
 * It exists in M0 so that swapping the event-log driver in M1 is a one-file change with a
 * pre-existing proof obligation, not a re-derivation of what the log guarantees
 * (CONTRACTS.md §8.1).
 *
 * `make()` must return a FRESH, empty log each time. Ring size is the driver's business, so
 * every assertion here is written to hold whether or not eviction has happened — what is
 * asserted is that `tail` tells the truth about it.
 */
export function runEventLogConformance(name: string, make: () => EventLog): void {
  describe(`EventLog conformance: ${name}`, () => {
    it("starts empty, with head 0 and tail 1", () => {
      const log = make();
      expect(log.head).toBe(0);
      expect(log.tail).toBe(1);
      expect(log.subscriberCount).toBe(0);
      expect(log.read(0)).toEqual([]);
      log.close();
    });

    it("assigns seq synchronously, from 1, gap-free, under 1000 interleaved appends", () => {
      const log = make();
      const assigned: Seq[] = [];
      for (let i = 0; i < 1_000; i++) {
        // Two simulated turns interleaving in one worker: the log is the single writer.
        const e = log.append(chunk(`m${i}`, i % 2 === 0 ? TURN_A : TURN_B));
        assigned.push(e.seq);
        expect(log.head).toBe(e.seq); // synchronous: head is already updated on return
      }
      expect(assigned[0]).toBe(1);
      expect(isGapFree(assigned)).toBe(true);
      expect(log.head).toBe(1_000);

      const replayed = log.read(0);
      expect(isGapFree(seqs(replayed))).toBe(true);
      expect(replayed.at(-1)?.seq).toBe(log.head);
      expect(replayed[0]?.seq).toBe(log.tail); // honest tail, whether or not the ring evicted
      log.close();
    });

    it("stamps the envelope fields the producer may not stamp", () => {
      const log = make();
      const e = log.append(chunk("hello", TURN_A));
      expect(e.seq).toBe(1);
      expect(e.workerId).toBe(log.workerId);
      expect(typeof e.ts).toBe("string");
      expect(e.ts.length).toBeGreaterThan(0);
      expect(e.turnId).toBe(TURN_A);
      expect(e.kind).toBe("acp.session_update");
      log.close();
    });

    it("freezes envelopes, so two readers cannot see different history", () => {
      const log = make();
      const e = log.append(chunk("frozen", null));
      expect(Object.isFrozen(e)).toBe(true);
      const [replayed] = log.read(0);
      expect(replayed).toBe(e);
      log.close();
    });

    it("appendAll assigns in array order in one critical section", () => {
      const log = make();
      const out = log.appendAll([chunk("a", TURN_A), chunk("b", TURN_A), chunk("c", TURN_A)]);
      expect(seqs(out)).toEqual([1, 2, 3]);
      expect(log.head).toBe(3);
      log.close();
    });

    it("read(since) is an EXCLUSIVE lower bound", () => {
      const log = make();
      log.appendAll([chunk("a", null), chunk("b", null), chunk("c", null)]);
      expect(seqs(log.read(0))).toEqual([1, 2, 3]);
      expect(seqs(log.read(1))).toEqual([2, 3]);
      expect(seqs(log.read(3))).toEqual([]);
      expect(seqs(log.read(99))).toEqual([]); // cursor skew is not an error
      expect(seqs(log.read(0, 2))).toEqual([1, 2]);
      log.close();
    });

    it("replays from 0, mid, head and below tail", () => {
      const log = make();
      for (let i = 0; i < 50; i++) log.append(chunk(`m${i}`, TURN_A));
      const tail = log.tail;
      const head = log.head;

      expect(log.read(0)[0]?.seq).toBe(tail);
      expect(seqs(log.read(Math.floor(head / 2)))[0]).toBe(Math.floor(head / 2) + 1);
      expect(log.read(head)).toEqual([]);
      // Below tail is not an error: the caller is told the truth by `tail`, and gets what is left.
      expect(log.read(tail - 1)[0]?.seq).toBe(tail);
      log.close();
    });

    it("subscribes with replay then live tail, with nothing slipping between", () => {
      const log = make();
      log.appendAll([chunk("a", null), chunk("b", null)]);

      const seen: Seq[] = [];
      const sub = log.subscribe(0, (e) => {
        seen.push(e.seq);
        // Appending from inside the listener must not corrupt the sequence.
        if (e.seq === 2) log.append(chunk("from-inside", null));
      });
      expect(seen).toEqual([1, 2, 3]); // replay was synchronous
      log.append(chunk("c", null));
      expect(seen).toEqual([1, 2, 3, 4]);
      expect(isGapFree(seen)).toBe(true);

      sub.close();
      expect(sub.closed).toBe(true);
      log.append(chunk("after", null));
      expect(seen).toEqual([1, 2, 3, 4]);
      expect(log.subscriberCount).toBe(0);
      log.close();
    });

    it("gives five concurrent subscribers with different cursors identical, +1 sequences", () => {
      const log = make();
      log.appendAll([chunk("a", null), chunk("b", null), chunk("c", null)]);

      const seen: Seq[][] = [];
      const subs = [0, 1, 2, 3, 99].map((since) => {
        const mine: Seq[] = [];
        seen.push(mine);
        return log.subscribe(since, (e) => mine.push(e.seq));
      });
      expect(log.subscriberCount).toBe(5);

      for (let i = 0; i < 10; i++) log.append(chunk(`live${i}`, TURN_B));

      for (const mine of seen) {
        expect(isGapFree(mine)).toBe(true);
        expect(mine.at(-1)).toBe(log.head);
      }
      expect(seen[0]?.length).toBeGreaterThan(seen[3]?.length ?? 0);
      // Same envelopes over the overlapping range — D5's multi-observer property.
      expect(seen[0]?.slice(-10)).toEqual(seen[4]);

      for (const s of subs) s.close();
      expect(log.subscriberCount).toBe(0);
      log.close();
    });

    it("delivers to a subscriber only what was appended after its cursor", () => {
      const log = make();
      log.appendAll([chunk("a", null), chunk("b", null)]);
      const seen: Seq[] = [];
      const sub = log.subscribe(log.head, (e) => seen.push(e.seq));
      expect(seen).toEqual([]);
      log.append(chunk("c", null));
      expect(seen).toEqual([3]);
      sub.close();
      log.close();
    });

    it("close() is idempotent and ends every subscription", () => {
      const log = make();
      const a = log.subscribe(0, () => {});
      const b = log.subscribe(0, () => {});
      expect(log.subscriberCount).toBe(2);

      log.close();
      expect(a.closed).toBe(true);
      expect(b.closed).toBe(true);
      expect(log.subscriberCount).toBe(0);

      log.close(); // idempotent
      a.close(); // closing a closed subscription is a no-op, not a throw
      expect(log.subscriberCount).toBe(0);
    });

    it("setSessionId stamps later envelopes and never back-fills earlier ones", () => {
      const log = make();
      const before = log.append(chunk("pre-handshake", null));
      expect(before.sessionId).toBeNull();

      log.setSessionId("sess-abc");
      const after = log.append(chunk("post-handshake", TURN_A));
      expect(after.sessionId).toBe("sess-abc");
      // §8.2 rule 3: the pre-handshake prefix is frozen at null — it precedes the session's
      // existence, and back-filling it would make two readers disagree (review R16).
      expect(log.read(0)[0]?.sessionId).toBeNull();
      log.close();
    });
  });
}

/**
 * The DURABLE half of the suite: §14.11's ten items, over a real sqlite file that is closed and
 * REOPENED (`make().reopen()` — same file, new handle).
 *
 * It is a separate function rather than a flag on `runEventLogConformance` because M0's suite
 * must keep running verbatim and unedited against BOTH drivers — that is what proves the ring
 * stayed (§14.1, F11) — while these ten items are meaningless for `driver:"memory"`.
 *
 * `make` is `typeof tmpPersistence`, so the package under test passes a zero-argument closure
 * over its OWN `openPersistence` / `createPersistedEventLog` (see `tmp-persistence.ts` for why
 * testkit cannot import them).
 *
 * Owned by M1-WP-A.
 */
export function runEventLogPersistenceConformance(name: string, make: typeof tmpPersistence): void {
  describe(`EventLog persistence conformance: ${name}`, () => {
    let t: TmpPersistence;

    beforeEach(async () => {
      t = await make();
    });

    afterEach(async () => {
      await t.dispose();
    });

    // ── 1 ────────────────────────────────────────────────────────────────────
    it("restores head, tail and every envelope across a close and reopen", async () => {
      const w = worker(1);
      const first = t.log({ workerId: w });
      const appended: EventEnvelope[] = [];
      for (let i = 0; i < 500; i++) appended.push(first.append(chunk(`m${i}`, TURN_A)));
      expect(first.head).toBe(500);
      first.flush();
      first.close();

      await t.reopen();
      const second = t.log({ workerId: w });

      expect(second.head).toBe(500);
      expect(second.tail).toBe(1);

      const replayed = second.read(0);
      expect(replayed).toHaveLength(500);
      // DEEP-EQUAL, not identity, and the difference is the whole design: the ring is empty
      // after a restart, so every one of these came off disk as a fresh object. Identity holds
      // only for what the ring still has, which is the range `runEventLogConformance` covers
      // (F11, §14.1).
      expect(replayed[0]).not.toBe(appended[0]);
      expect(replayed.map(durable)).toEqual(appended.map(durable));
      second.close();
    });

    // ── 2 ────────────────────────────────────────────────────────────────────
    it("continues the sequence after a reopen: append 500, reopen, append ⇒ seq 501", async () => {
      const w = worker(2);
      const first = t.log({ workerId: w });
      for (let i = 0; i < 500; i++) first.append(chunk(`m${i}`, null));
      first.close();

      await t.reopen();
      const second = t.log({ workerId: w });
      expect(second.append(chunk("after the restart", null)).seq).toBe(501);
      expect(second.head).toBe(501);
      second.close();
    });

    // ── 3 ────────────────────────────────────────────────────────────────────
    it("continues the sequence after retention evicted EVERYTHING: seq 501, not 1", async () => {
      const w = worker(3);
      const first = t.log({ workerId: w });
      for (let i = 0; i < 500; i++) first.append(chunk(`m${i}`, null));
      first.close();

      // The §14.4 case, and the one that eats a whole class of logs: the rows are gone while the
      // worker is not. `max(seq)` is NULL here ⇒ a naive restore says head 0 and the next append
      // is seq 1 again, so every client holding `?since=300` silently receives nothing forever.
      expect(t.handle.events.evict(w, t.handle.events.headOf(w))).toBe(500);

      await t.reopen();
      const second = t.log({ workerId: w });

      expect(second.head).toBe(500);
      // "Nothing retained, and here is where the next one will be" — never 1, which would
      // promise history that no longer exists.
      expect(second.tail).toBe(501);
      expect(second.read(0)).toEqual([]);
      expect(second.append(chunk("after the sweep", null)).seq).toBe(501);
      second.close();
    });

    // ── 4 ────────────────────────────────────────────────────────────────────
    it("round-trips a 12 KB available_commands_update and its _meta byte-for-byte", async () => {
      const w = worker(4);
      const payload = bigCommandsUpdate();
      const before = JSON.stringify(payload);
      expect(before.length).toBeGreaterThan(12_000);

      const first = t.log({ workerId: w });
      const appended = first.append({ kind: "acp.session_update", payloadVersion: 1, payload });
      first.close();

      await t.reopen();
      const second = t.log({ workerId: w });
      const [replayed] = second.read(0);

      // Byte-for-byte, `_meta` included: §7.5's forwarding guarantee extends to disk, so a
      // client that reconnects after a restart renders exactly what a live one did.
      expect(JSON.stringify(replayed?.payload)).toBe(before);
      expect(JSON.stringify(replayed?.payload)).toBe(JSON.stringify(appended.payload));
      const meta = (replayed?.payload as { _meta: Record<string, unknown> })._meta;
      expect(meta["_claude/rateLimit"]).toEqual(RATE_LIMIT);
      second.close();
    });

    // ── 5 ────────────────────────────────────────────────────────────────────
    it("degrades — never throws — when a durable write fails, and says so", () => {
      const w = worker(5);
      const owner = t.log({ workerId: w });
      owner.appendAll([chunk("a", null), chunk("b", null), chunk("c", null)]);

      // A REAL durable failure, not a stub that throws: a second log over the same worker forced
      // to start from 0 collides with `events`' `(worker_id, seq)` primary key — §14.7's backstop
      // against a second daemon assigning `seq` from its own head.
      const doubled = t.log({ workerId: w, startSeq: 0 });
      const seen: Seq[] = [];
      const sub = doubled.subscribe(0, (e) => seen.push(e.seq));

      const failures = t.handle.events.diagnostics.writeFailures;
      const first = doubled.append(chunk("collides", null));

      // The append still RETURNED an envelope: `Worker.#feed` catches and drops, so a throw here
      // would silently eat the event instead of degrading loudly (§14.3).
      expect(first.seq).toBe(1);
      expect(persistenceOf(doubled)).toBe("degraded");
      expect(t.handle.events.diagnostics.writeFailures).toBeGreaterThan(failures);

      const next = doubled.append(chunk("still going", null));
      // Gap-free, and the `seq` was NOT rolled back: rolling it back would leave the ring and
      // the disk holding different envelopes at the same seq.
      expect(isGapFree(seqs(doubled.read(0)))).toBe(true);
      expect(next.seq).toBe(doubled.head);
      // The subscriber saw everything, including the ONE in-band `omni.error` that tells it this
      // worker's history will not survive a restart.
      expect(isGapFree(seen)).toBe(true);
      expect(seen).toContain(first.seq);
      expect(seen).toContain(next.seq);
      expect(doubled.read(0).filter((e) => e.kind === "omni.error")).toHaveLength(1);

      sub.close();
      doubled.close();
      owner.close();
    });

    // ── 6 ────────────────────────────────────────────────────────────────────
    it("keeps two logs over one store from seeing each other's head", async () => {
      const a = t.log({ workerId: worker(6) });
      const b = t.log({ workerId: worker(7) });

      for (let i = 0; i < 5; i++) a.append(chunk(`a${i}`, null));
      for (let i = 0; i < 2; i++) b.append(chunk(`b${i}`, null));

      expect(a.head).toBe(5);
      expect(b.head).toBe(2);
      expect(seqs(a.read(0))).toEqual([1, 2, 3, 4, 5]);
      expect(seqs(b.read(0))).toEqual([1, 2]);
      a.close();
      b.close();

      await t.reopen();
      expect(t.log({ workerId: worker(6) }).head).toBe(5);
      expect(t.log({ workerId: worker(7) }).head).toBe(2);
    });

    // ── 7 ────────────────────────────────────────────────────────────────────
    it("holds a per-append latency budget over 5 000 appends", () => {
      const log = t.log({ workerId: worker(8) });
      const started = performance.now();
      for (let i = 0; i < 5_000; i++) log.append(chunk(`m${i}`, TURN_B));
      const perAppend = (performance.now() - started) / 5_000;

      // The budget guards two regressions this suite cannot otherwise see: a `db.prepare()` that
      // slipped inside the loop, and a Windows fsync that turned WAL + NORMAL into a per-append
      // disk flush. It is deliberately loose — 1 ms is ~90x the measured cost (F12) — because a
      // tight budget on shared CI hardware fails for reasons that are not regressions.
      expect(perAppend).toBeLessThan(1 * SLOW);
      expect(log.head).toBe(5_000);
      log.close();
    });

    // ── 8 ────────────────────────────────────────────────────────────────────
    it("leaves the store usable after a log closes — they have separate lifetimes", () => {
      const w = worker(9);
      const first = t.log({ workerId: w });
      first.append(chunk("before", null));
      first.close();

      const second = t.log({ workerId: w });
      expect(second.head).toBe(1);
      expect(second.append(chunk("after", null)).seq).toBe(2);
      expect(t.handle.events.headOf(w)).toBe(2);
      expect(seqs(t.handle.events.read(w, 0, 10))).toEqual([1, 2]);
      second.close();
    });

    // ── 9 ────────────────────────────────────────────────────────────────────
    it("stores 23 available_commands_update appends as 2 payloads, read back identical", () => {
      const w = worker(10);
      const log = t.log({ workerId: w });
      const shapes = [bigCommandsUpdate(), bigCommandsUpdate("v2")];
      const appended: EventEnvelope[] = [];
      for (let i = 0; i < 23; i++) {
        const payload = shapes[i < 12 ? 0 : 1] as NormalizedSessionUpdate;
        appended.push(log.append({ kind: "acp.session_update", payloadVersion: 1, payload }));
      }

      // §14.6: stream in full, store by content digest. 23 envelopes, 23 seqs, 2 payload rows —
      // the envelope count, the `seq` and the ordering are all unchanged, which is what makes
      // the optimisation safe to have at all.
      expect(t.payloadCount()).toBe(2);
      expect(log.head).toBe(23);

      const live = log.read(0);
      expect(live.map(durable)).toEqual(appended.map(durable));
      log.close();

      // And the same off disk, where the ring is not there to answer for it.
      const replayed = t.handle.events.read(w, 0, 100);
      expect(replayed.map(durable)).toEqual(appended.map(durable));
    });

    // ── 10 ───────────────────────────────────────────────────────────────────
    it("reads across the ring floor with the ring sized to 3", () => {
      const log = t.log({ workerId: worker(11), maxEvents: 3 });
      const appended: EventEnvelope[] = [];
      for (let i = 1; i <= 10; i++) appended.push(log.append(chunk(`m${i}`, null)));

      // The ring holds 8, 9, 10. Everything below the floor comes off disk, and `tail` says 1
      // because with a backend the ring is a CACHE and the tail comes from disk (§14.5).
      expect(log.tail).toBe(1);
      expect(seqs(log.read(0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(seqs(log.read(5))).toEqual([6, 7, 8, 9, 10]);
      expect(seqs(log.read(0, 4))).toEqual([1, 2, 3, 4]);
      expect(seqs(log.read(7))).toEqual([8, 9, 10]);
      expect(seqs(log.read(0, 9))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      // Identity for the ring's own range, deserialized copies below it: the two sources are
      // capped against each other so a seq can never appear twice.
      const all = log.read(0);
      expect(all[9]).toBe(appended[9]);
      expect(all[7]).toBe(appended[7]);
      expect(all[0]).not.toBe(appended[0]);
      expect(durable(all[0] as EventEnvelope)).toEqual(durable(appended[0] as EventEnvelope));
      log.close();
    });

    it("survives a randomized append / read / evict fuzz: gap-free, no duplicates", () => {
      const w = worker(12);
      const log = t.log({ workerId: w, maxEvents: 7 });
      const random = lcg(0x5eed);

      for (let round = 0; round < 120; round++) {
        const appends = 1 + Math.floor(random() * 6);
        for (let i = 0; i < appends; i++) log.append(chunk(`r${round}-${i}`, null));

        if (round % 11 === 10 && log.head > 20) {
          // Evict a prefix from UNDER the log's feet — the sweep runs on a timer and does not
          // ask the log's permission. `tail` must move, `head` must not.
          const head = log.head;
          t.handle.events.evict(w, log.tail + Math.floor(random() * 5));
          expect(log.head).toBe(head);
        }

        const since = Math.floor(random() * (log.head + 3));
        const limit = 1 + Math.floor(random() * 30);
        for (const out of [log.read(since), log.read(since, limit)]) {
          const got = seqs(out);
          expect(isGapFree(got)).toBe(true);
          expect(new Set(got).size).toBe(got.length);
          expect(got.every((s) => s > since)).toBe(true);
          if (got.length > 0) {
            expect(got[0]).toBe(Math.max(since + 1, log.tail));
            expect(got.at(-1)).toBeLessThanOrEqual(log.head);
          }
        }
        expect(log.tail).toBeLessThanOrEqual(log.head + 1);
      }
      log.close();
    });
  });
}

/** A deterministic PRNG, so a red fuzz run is reproducible rather than a story about a seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** The fields §14.11 item 1 names, which is what "deep-equal, not identity" is measured on. */
const durable = (e: EventEnvelope): Record<string, unknown> => ({
  seq: e.seq,
  ts: e.ts,
  kind: e.kind,
  payload: e.payload,
  turnId: e.turnId,
  sessionId: e.sessionId,
  daemonId: e.daemonId,
  workerId: e.workerId,
  payloadVersion: e.payloadVersion,
});

/**
 * §14.3's third answer, read structurally.
 *
 * `EventLog.persistent` is a boolean and cannot say "the write-through FAILED but the log is
 * still correct in RAM". The persisted driver carries the honest three-way answer as an extra
 * member; a log that does not have it is a driver with no durable side, and `"memory"` is the
 * right thing to report for it.
 */
function persistenceOf(log: EventLog): "memory" | "durable" | "degraded" {
  const maybe = log as EventLog & { persistence?: "memory" | "durable" | "degraded" };
  return maybe.persistence ?? (log.persistent ? "durable" : "memory");
}

const worker = (n: number): WorkerId => `w_${String(n).padStart(26, "0")}` as WorkerId;

/** F13's `_meta["_claude/rateLimit"]` block, whose survival item 4 is about. */
const RATE_LIMIT = {
  status: "allowed",
  unifiedRateLimitFallbackAvailable: false,
  resetsAt: 1_767_225_600,
} as const;

/**
 * A stand-in for the corpus's 12.7 KB `available_commands_update` (F13).
 *
 * Synthetic on purpose: testkit's corpus loader is another work package's file, and item 4 is
 * about the JSON round trip surviving a payload of that SHAPE and SIZE — a nested `_meta`, a
 * long array of vendor-shaped objects — not about those particular commands. The REAL corpus
 * runs against this same code in `@omni-acp/core`'s own digest test, which is where acceptance
 * bullet 7's "23 appends, 2 stored payloads" is proven on the recorded bytes.
 */
function bigCommandsUpdate(tag = "v1"): NormalizedSessionUpdate {
  const availableCommands = Array.from({ length: 60 }, (_, i) => ({
    name: `command-${tag}-${i}`,
    description: `A synthetic slash command whose description is long enough to matter: ${"d".repeat(120)}`,
    input: { hint: `<argument ${i}>` },
    _meta: { "_claude/source": "builtin", index: i },
  }));
  return {
    sessionUpdate: "available_commands_update",
    availableCommands,
    _meta: { "_claude/rateLimit": RATE_LIMIT, "_claude/tag": tag },
  } as unknown as NormalizedSessionUpdate;
}
