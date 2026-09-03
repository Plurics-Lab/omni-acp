import { describe, expect, it } from "vitest";
import type { EventEnvelope, EventInput, EventLog, Seq, TurnId } from "@omni-acp/protocol";

const TURN_A = `t_${"0".repeat(25)}1` as TurnId;
const TURN_B = `t_${"0".repeat(25)}2` as TurnId;

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
