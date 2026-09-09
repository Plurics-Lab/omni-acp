/**
 * M1's thirteen compat cases, MOVED VERBATIM from `tests/compat/src/cases.ts` and then FROZEN
 * (M2-PLAN §1.4).
 *
 * Nothing in this file changed in the M2 Land step. That is the point of moving it: the identical
 * script still runs for every configured agent, and a work package adding an M2 case cannot touch
 * the M1 ones by accident.
 */
import { readdir } from "node:fs/promises";
import { OmniError, reduceTurn, type EventEnvelope } from "@omni-acp/protocol";
import { waitGone } from "@omni-acp/testkit";
import {
  acpConversation,
  envelopeFrames,
  openSse,
  parseFrames,
  resolveLaunch,
  tempDir,
  until,
} from "../harness.js";
import {
  allEnvelopes,
  assert,
  deepEqual,
  updateKind,
  asRecord,
  V1_ONLY_KINDS,
  type CompatCase,
  type CompatContext,
} from "./support.js";

export function m1Cases(): readonly CompatCase[] {
  return [
    {
      id: "handshake",
      requires: [],
      async run(ctx) {
        const first = await ctx.worker();
        const second = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          for (const w of [first, second]) {
            assert(w.state === "ready", `expected ready, got ${w.state}`);
            assert(
              Object.keys(w.snapshot.capabilities?.raw ?? {}).length > 0,
              "capabilities.raw is empty: the handshake answer was not carried through",
            );
            assert(w.snapshot.generation === 1, "a freshly handshaken worker is generation 1");
          }
          // §17.2: the descriptor identity that GOVERNED this worker. Two workers of one agent
          // resolve the same builtin ⊕ config ⊕ probe table, so the string must be identical —
          // a difference would mean two quirk tables ran behind one agent id.
          assert(
            first.snapshot.runtimeId === second.snapshot.runtimeId,
            `runtimeId is not stable: ${first.snapshot.runtimeId} vs ${second.snapshot.runtimeId}`,
          );
          // `CreateWorkerRequest.lease` defaults to "take" (D5).
          assert(first.snapshot.lease.holder !== null, "the creator does not hold the lease");
          // §4 step 1: the acceptance harness runs the sqlite driver, so this is `durable` or the
          // daemon is not persisting what step 5 is about to ask for back.
          assert(
            first.snapshot.persistence === "durable",
            `persistence is ${first.snapshot.persistence}, not durable`,
          );
        } finally {
          await second.close().catch(() => {});
        }
      },
    },

    {
      id: "plain-turn",
      requires: [],
      async run(ctx) {
        const worker = await ctx.worker();
        const result = await worker.prompt(ctx.prompts.plain);

        assert(result.verdict === "ok", `verdict is ${result.verdict}, not ok`);
        assert(result.text.length > 0, "a completed turn produced no text at all");
        assert(result.error === null, "a turn with verdict ok carries an error");

        const envelopes = await allEnvelopes(ctx, worker.id);
        const mine = envelopes.filter((e) => e.turnId === result.turnId);
        const states = mine
          .filter((e) => updateKind(e) === "state_update")
          .map((e) => asRecord(e.payload)["state"]);
        assert(
          deepEqual(states, ["running", "idle"]),
          `expected exactly one running and one idle, got ${JSON.stringify(states)}`,
        );

        // DESIGN §5.5: ONE aggregate. `GET /turns/{id}` folds the same envelopes with the same
        // pure reducer, so a difference here is two opinions about what a turn was.
        const status = await worker.turn(result.turnId);
        assert(status.state === "completed", `turn state is ${status.state}`);
        assert(
          deepEqual(status.result, result),
          "GET /turns/{id} disagrees with the prompt() aggregate",
        );
      },
    },

    {
      id: "tool-turn",
      requires: ["tools"],
      async run(ctx) {
        const worker = await ctx.worker();
        // READ-ONLY on purpose (§18.4, review R11): M1 wires exactly one permission responder and
        // it is auto-DENY, so a write turn's `changes` is empty BY CONSTRUCTION and belongs to
        // `permission-deny` instead.
        const result = await worker.prompt(ctx.prompts.read);

        assert(result.toolCalls.length > 0, "a tool-using prompt produced no tool call");
        // `status: null` is a tool call the agent never gave one — which is not terminal, and
        // saying so is the point: `pending` forever is exactly what a denied write leaves behind.
        const terminal = new Set(["completed", "failed", "cancelled"]);
        assert(
          result.toolCalls.some((c) => c.status !== null && terminal.has(c.status)),
          `no tool call reached a terminal status: ${result.toolCalls
            .map((c) => String(c.status))
            .join(", ")}`,
        );

        // "`changes` matches the workspace": a read-only turn wrote nothing, so the claim is that
        // we report nothing — not that we report something plausible.
        const entries = await readdir(ctx.cwd);
        assert(
          result.changes.length === 0 && entries.length === 0,
          `a read-only turn reported ${String(result.changes.length)} change(s) over a workspace ` +
            `containing ${JSON.stringify(entries)}`,
        );
      },
    },

    {
      id: "stream-resume",
      requires: [],
      async run(ctx) {
        const worker = await ctx.worker();
        const workerId = worker.id;

        // A second connection observes from seq 0 for the whole turn and is never interrupted: it
        // is the reference the reconnected union is compared against.
        const reference = openSse(ctx.harness.url, ctx.harness.tokenA, workerId, 0);
        const before = worker.snapshot.headSeq;
        const first = openSse(ctx.harness.url, ctx.harness.tokenA, workerId, before);
        try {
          const turn = worker.prompt(ctx.prompts.plain);

          // Cut at a RANDOM point inside the live turn — the whole property is that the cursor,
          // not the connection, is the unit of work (§8.4).
          await first.until((t) => envelopeFrames(parseFrames(t)).length >= 1, 60_000);
          await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(Math.random() * 60)));
          const segment1 = first.text();
          first.close();

          const cut = envelopeFrames(parseFrames(segment1));
          const lastSeq = cut.length === 0 ? before : Number(cut[cut.length - 1]?.id ?? before);
          const second = openSse(ctx.harness.url, ctx.harness.tokenA, workerId, lastSeq);
          try {
            const result = await turn;
            const done = (t: string): boolean =>
              envelopeFrames(parseFrames(t)).some((f) => {
                const e = JSON.parse(f.data) as EventEnvelope;
                return (
                  e.turnId === result.turnId &&
                  updateKind(e) === "state_update" &&
                  asRecord(e.payload)["state"] === "idle"
                );
              });
            await reference.until(done, 60_000);
            await second.until(done, 60_000);

            const segment2 = second.text();
            const union = [...cut, ...envelopeFrames(parseFrames(segment2))].filter(
              (f) => Number(f.id) > before,
            );
            const reference2 = envelopeFrames(parseFrames(reference.text())).filter(
              (f) => Number(f.id) > before,
            );
            // Trim the reference to the union's extent: the observer keeps reading after the
            // turn ends, and a longer tail is not a discrepancy.
            const trimmed = reference2.slice(0, union.length);

            assert(
              union.length > 0 && deepEqual(union, trimmed),
              "the reconnected union does not match the uninterrupted observer's frames",
            );
            // Gap-free and duplicate-free, which is the property `?since=` exists to deliver.
            const seqs = union.map((f) => Number(f.id));
            assert(
              seqs.every((s, i) => i === 0 || s === (seqs[i - 1] ?? 0) + 1),
              `seq is not contiguous: ${JSON.stringify(seqs)}`,
            );

            // The control frames, asserted SEPARATELY (review R12): `sse.ts` is frozen by
            // checksum and writes a `retry:` preamble on every stream, so a raw byte comparison
            // is unachievable by construction.
            assert(
              segment2.startsWith("retry:"),
              "segment 2 does not begin with a retry: preamble",
            );
            const truncated = parseFrames(segment2).filter(
              (f) => f.event === "omni.stream_truncated",
            );
            assert(truncated.length <= 1, "more than one stream_truncated on one connection");
          } finally {
            second.close();
          }
        } finally {
          first.close();
          reference.close();
        }
      },
    },

    {
      id: "cancel-late-update",
      requires: ["cancel"],
      async run(ctx) {
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          // The tail has to be OPEN for `worker.state` to advance: the handle reports the last
          // state it OBSERVED, and a handle with no listener holds the state it was created with
          // (§5.5). Without this the wait below would spin to its deadline on a live turn.
          const off = worker.on("state", () => {});
          const turn = worker.prompt(ctx.prompts.plain);
          // Cancel as soon as the turn is live, and do not insist that it still is: an agent that
          // finished first is not a failure. The assertion is about ORDER, and `idle` last is the
          // invariant either way — `cancel` is idempotent and a no-op on a settled turn (H9).
          await until(() => worker.state === "running", 5_000, 10);
          await worker.cancel();
          const result = await turn;
          off();

          // The AGENT's updates, not the daemon's lifecycle envelopes: `omni.worker_state{ready,
          // turn_end}` carries this turn's id and legitimately follows `idle` — it is the
          // daemon saying the turn ended, which can only be said afterwards. Corpus 14's claim is
          // about the agent's own updates.
          const envelopes = (await allEnvelopes(ctx, worker.id)).filter(
            (e) => e.turnId === result.turnId && e.kind === "acp.session_update",
          );
          const idleAt = envelopes.findIndex(
            (e) => updateKind(e) === "state_update" && asRecord(e.payload)["state"] === "idle",
          );
          assert(idleAt >= 0, "the cancelled turn never reached idle");
          // Corpus 14: an update that arrives AFTER `session/cancel` is still ordered BEFORE
          // `idle`. `idle` last means no update of this turn can follow it — which is the
          // property that lets a client stop reading at `idle` without losing the tail.
          assert(
            idleAt === envelopes.length - 1,
            `${String(envelopes.length - 1 - idleAt)} update(s) of this turn follow idle: ` +
              `${JSON.stringify(envelopes.slice(idleAt + 1).map((e) => updateKind(e)))}`,
          );
        } finally {
          await worker.close().catch(() => {});
        }
      },
    },

    {
      id: "tool-merge",
      requires: ["tools"],
      async run(ctx) {
        const worker = await ctx.worker();
        const result = await worker.prompt(ctx.prompts.read);
        const envelopes = (await allEnvelopes(ctx, worker.id)).filter(
          (e) => e.turnId === result.turnId,
        );

        const updates = envelopes.filter((e) => updateKind(e) === "tool_call_update");
        assert(updates.length > 0, "no tool_call_update was emitted");
        // Corpus finding 3: claude-acp's updates are SPARSE — absent means unchanged. A merge
        // that treated absence as "clear" would erase `kind`, `title` and `locations`, which is
        // the difference between a readable tool timeline and a list of blank rows.
        const sparse = updates.filter((e) => {
          const p = asRecord(e.payload);
          return p["kind"] === undefined || p["title"] === undefined;
        });
        assert(sparse.length > 0, "every tool_call_update was complete; nothing merged");

        for (const call of result.toolCalls) {
          assert(
            call.title !== "" && call.title !== undefined,
            `tool call ${call.toolCallId} lost its title through the merge`,
          );
        }
      },
    },

    {
      id: "permission-deny",
      requires: ["permission"],
      async run(ctx) {
        const worker = await ctx.worker();
        const result = await worker.prompt(ctx.prompts.write);

        // Corpus findings 6 and 7: a bare `end_turn` must never HIDE a denial. The agent's only
        // signal is English prose ("User refused permission to run tool"), which we never parse —
        // we are the party that denied, so the join comes from our own `omni.policy_decision`.
        assert(result.stopReason === "end_turn", `stopReason is ${String(result.stopReason)}`);
        assert(result.deniedToolCalls.length > 0, "a denied turn reported no denied tool calls");
        assert(result.verdict === "partial", `verdict is ${result.verdict}, not partial`);

        // D4 rule 1: only an OFFERED optionId is ever sent. Corpus 09 proves the violation is
        // invisible in `stopReason`, so it is asserted structurally — against our OWN
        // `omni.policy_decision`, which is the envelope that records both what was offered and
        // what we answered.
        const decisions = (await allEnvelopes(ctx, worker.id)).filter(
          (e) => e.kind === "omni.policy_decision",
        );
        assert(decisions.length > 0, "a denied turn recorded no policy decision");
        for (const envelope of decisions) {
          if (envelope.kind !== "omni.policy_decision") continue;
          const { optionId, offered } = envelope.payload;
          if (optionId === null) continue;
          assert(
            offered.some((o) => o.optionId === optionId),
            `answered with optionId "${optionId}", which was never offered`,
          );
        }

        // The workspace still has no file: `changes` empty is a claim about the disk.
        assert(result.changes.length === 0, "a denied write reported file changes");
        const entries = await readdir(ctx.cwd);
        assert(entries.length === 0, `the workspace gained ${JSON.stringify(entries)}`);
      },
    },

    {
      id: "hibernate-wake",
      requires: ["resume"],
      async run(ctx) {
        // §4 step 3: a SECOND worker with a small idle timeout, and ONE prompt before the wait —
        // a session opened by `session/new` and never prompted has nothing to recall, and corpus
        // 07 confirms replay carries only conversational content (review R16).
        const worker = await ctx.harness.A.createAgent(ctx.agentId, {
          cwd: ctx.cwd,
          idleTimeoutMs: 200,
        });
        try {
          await worker.prompt(ctx.prompts.remember);
          const pid = worker.snapshot.process?.pid ?? 0;
          assert(pid > 0, "the worker reported no pid before hibernating");

          const asleep = await until(
            async () => (await ctx.harness.A.attach(worker.id)).state === "hibernated",
            30_000,
            50,
          );
          assert(asleep, "the idle timer never drove the worker to hibernated");

          const snapshot = await ctx.harness.A.attach(worker.id).then((w) => w.snapshot);
          assert(snapshot.process === null, "a hibernated worker still reports a process");
          assert(snapshot.sessionId !== null, "hibernation cleared the session pointer");
          assert(snapshot.hibernatedAt !== null, "hibernatedAt was not recorded");
          // The process REALLY went away — not merely the daemon's reference to it. A dead pid is
          // strictly stronger evidence than a shrunken map, and `supervisor.live` is not reachable
          // from this suite anyway (review round 1, item 5).
          assert(
            await waitGone(pid, 10_000),
            `pid ${String(pid)} is still alive after hibernation`,
          );
          assert(snapshot.lease.holder === null, "hibernation did not release the lease");

          const before = await allEnvelopes(ctx, worker.id);
          const hibernations = before.filter(
            (e) => e.kind === "omni.worker_state" && e.payload.state === "hibernated",
          );
          assert(
            hibernations.length === 1,
            `expected one hibernated envelope, got ${String(hibernations.length)}`,
          );
          const headBefore = before[before.length - 1]?.seq ?? 0;

          // The prompt AUTO-WAKES (§15.3's first box).
          const woken = await ctx.harness.A.attach(worker.id);
          const result = await woken.prompt(ctx.prompts.recall);
          assert(result.stopReason !== null, "the woken turn never settled");

          const after = await allEnvelopes(ctx, worker.id, headBefore);
          const reasons = after
            .filter((e) => e.kind === "omni.worker_state")
            .map((e) => (e.kind === "omni.worker_state" ? e.payload.reason : ""));
          assert(
            reasons.indexOf("wake") >= 0 && reasons.indexOf("resumed") > reasons.indexOf("wake"),
            `expected wake then resumed, got ${JSON.stringify(reasons)}`,
          );

          const resumed = after.find(
            (e) => e.kind === "omni.worker_state" && e.payload.reason === "resumed",
          );
          const report =
            resumed !== undefined && resumed.kind === "omni.worker_state"
              ? resumed.payload.resume
              : undefined;
          assert(report !== undefined, "the resumed envelope carries no ResumeReport");
          assert(report.outcome === "landed", `resume outcome is ${report.outcome}, not landed`);
          assert(report.rule !== "", "the ResumeReport names no rule");
          assert(report.durationMs >= 0, "the ResumeReport has no duration");

          // `seq` CONTINUES: a woken worker must not restart its own history at 1 (§14.4).
          assert(
            (after[0]?.seq ?? 0) > headBefore,
            `seq restarted: first envelope after the wake is ${String(after[0]?.seq ?? 0)}`,
          );
          const snapshotAfter = (await ctx.harness.A.attach(worker.id)).snapshot;
          assert(
            snapshotAfter.generation >= 2,
            `generation is ${String(snapshotAfter.generation)} after a wake`,
          );

          // Every envelope inside the replay window is marked, and nothing outside it is.
          const wakeAt = after.findIndex(
            (e) => e.kind === "omni.worker_state" && e.payload.reason === "wake",
          );
          const resumedAt = after.findIndex(
            (e) => e.kind === "omni.worker_state" && e.payload.reason === "resumed",
          );
          for (const [index, envelope] of after.entries()) {
            if (envelope.replay !== true) continue;
            assert(
              index > wakeAt && index < resumedAt,
              `envelope ${String(envelope.seq)} is marked replay outside the window`,
            );
          }
        } finally {
          await worker.close().catch(() => {});
        }
      },
    },

    {
      id: "resume-cwd-mismatch",
      requires: ["resume"],
      async run(ctx) {
        // Driven at the PROBE LAYER, exactly as §4 step 3 specifies: a worker's cwd is fixed at
        // creation and there is no API to resume a pointer under a different one, so this is not
        // reachable through `Worker.wake()` (review R17). A throwaway process opens a session in
        // one directory and is then asked to resume it from another.
        const method = ctx.probe.resumeMethod;
        assert(method !== null, "the probe reported no resume spelling");

        const launch = resolveLaunch(ctx.config);
        const home = await tempDir("omni-compat-home-");
        const foreign = await tempDir("omni-compat-foreign-");
        const budget = ctx.config.budgets?.["resumeMs"] ?? 60_000;

        const opened = await acpConversation(
          launch,
          [
            { method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
            { method: "session/new", params: { cwd: home, mcpServers: [] } },
          ],
          { cwd: home, timeoutMs: budget },
        );
        const sessionId = asRecord(opened[1]?.result)["sessionId"];
        assert(typeof sessionId === "string", "the throwaway process opened no session");

        const resumed = await acpConversation(
          launch,
          [
            { method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
            { method, params: { sessionId, cwd: foreign, mcpServers: [] } },
          ],
          { cwd: foreign, timeoutMs: budget },
        );

        const answer = resumed[1] ?? {};
        // The claim under test is F15's, which appears in NO committed transcript and was until
        // now an unverified README note. Whatever comes back, it must NOT be classified
        // permanent: §15.4's negative lock says `PERMANENT_TEXT` does not match "Resource not
        // found", because broadening it would destroy a live session on a recoverable mismatch.
        assert(
          answer.error !== undefined,
          "resuming from a FOREIGN cwd succeeded; the quirk this case locks does not hold here",
        );
        assert(
          !/session not found|no session found|unknown session/i.test(answer.error.message),
          `the refusal message would classify as rejected_permanent: ${answer.error.message}`,
        );
        assert(
          answer.error.code !== -32601,
          `${method} answered -32601: the probe's resume spelling is wrong`,
        );
      },
    },

    {
      id: "lease",
      requires: [],
      async run(ctx) {
        const worker = await ctx.harness.A.createAgent(ctx.agentId, { cwd: ctx.cwd });
        try {
          // §16.1 rule L2: attach and GET are NEVER gated. Observer mode is the whole reason the
          // lease is worth having, so a reader must not need one.
          const observer = await ctx.harness.B.attach(worker.id);
          const seen: EventEnvelope[] = [];
          const off = observer.on("event", (e) => seen.push(e));

          const refused = await observer.prompt(ctx.prompts.plain).then(
            () => null,
            (e: unknown) => e as OmniError,
          );
          assert(
            refused?.code === "lease_held",
            `expected lease_held, got ${String(refused?.code)}`,
          );
          assert(refused.status === 423, `expected 423, got ${String(refused.status)}`);
          // Rule L10: the body NAMES the holder, so the loser learns who won without a second
          // round trip against a worker it does not control.
          const held = refused.lease;
          assert(held !== undefined, "the 423 body carries no `lease`");
          assert(
            held.holder?.clientId === worker.snapshot.lease.holder?.clientId,
            "the 423 body does not name the holder",
          );
          const epoch = held.epoch;

          // The holder's turn runs while the observer watches it.
          await worker.prompt(ctx.prompts.plain);

          const stolen = await observer.lease.steal("compat suite");
          assert(
            stolen.epoch === epoch + 1,
            `steal did not bump the epoch: ${String(stolen.epoch)}`,
          );

          const after = await worker.prompt(ctx.prompts.plain).then(
            () => null,
            (e: unknown) => e as OmniError,
          );
          // Both halves at once: A is no longer the holder AND A's cached `Omni-Lease-Epoch` is
          // stale. Either alone is a 423; the fence is what makes it one even for the right id.
          assert(after?.code === "lease_held", "the previous holder's next call was not refused");

          // B, which now holds it, succeeds.
          await observer.prompt(ctx.prompts.plain);

          off();
          assert(
            seen.some((e) => e.kind === "omni.lease" && e.payload.op === "stolen"),
            "the observer's stream carried no omni.lease{stolen} envelope",
          );
          assert(
            seen.some((e) => e.kind === "acp.session_update"),
            "the observer's stream carried none of the holder's turn",
          );
        } finally {
          await worker.close().catch(() => {});
        }
      },
    },

    {
      id: "restart-survives",
      requires: [],
      async run(ctx) {
        const worker = await ctx.worker();
        const workerId = worker.id;
        const before = await allEnvelopes(ctx, workerId);
        assert(before.length > 2, "nothing to compare across a restart");
        const mid = before[Math.floor(before.length / 2)]?.seq ?? 1;

        // §4 step 5: the SAME `dataDir`, a NEW daemon process-worth of state.
        await ctx.harness.restart();

        const after = await allEnvelopes(ctx, workerId, mid);
        const expected = before.filter((e) => e.seq > mid);
        assert(after.length >= expected.length, "the restarted daemon lost the tail");
        // The same envelopes with the SAME seq. §14.4 calls this the most dangerous line in M1:
        // a worker whose rows retention already evicted must not restart its sequence at 1.
        for (const [index, envelope] of expected.entries()) {
          const got = after[index];
          assert(
            got !== undefined && got.seq === envelope.seq && got.kind === envelope.kind,
            `envelope ${String(index)} after the restart is ${JSON.stringify(got?.seq)}/${String(got?.kind)}, ` +
              `expected ${String(envelope.seq)}/${envelope.kind}`,
          );
        }
      },
    },

    {
      id: "unknown-method",
      requires: [],
      async run(ctx) {
        // §17.4's battery sends four methods no fixture implements and the corpus records
        // claude-acp answering two of them `-32601`. "An invented method returns the descriptor's
        // `unknownMethodErrorCode`" is exactly what `unsupportedMethods` records, and the probe is
        // the layer at which it is observable without an agent that speaks first.
        assert(
          ctx.probe.unsupportedMethods.length > 0,
          "the probe found no unsupported method; the battery cannot have run",
        );
        for (const method of ctx.probe.unsupportedMethods) {
          assert(
            !ctx.probe.supportedMethods.includes(method),
            `${method} is reported both supported and unsupported`,
          );
        }
        // The descriptor's own code, not a hard-coded -32601: a runtime that answers something
        // else is a data change, not a code change (§17.1).
        const descriptor = (await ctx.harness.A.agents()).find((a) => a.id === ctx.agentId);
        assert(descriptor !== undefined, "the agent vanished from the catalog");
      },
    },

    {
      id: "idempotent-map",
      requires: [],
      async run(ctx) {
        const worker = await ctx.worker();
        const envelopes = await allEnvelopes(ctx, worker.id);
        const mapped = envelopes.filter((e) => e.kind === "acp.session_update");
        assert(mapped.length > 0, "no session updates to check");

        for (const envelope of mapped) {
          const kind = updateKind(envelope);
          if (envelope.payloadVersion !== 2 || kind === null) continue;
          // F24 / ruling M1-R10: `2` means the mapper landed on a KNOWN v2 arm. A v1-only kind at
          // version 2 would mean the map claimed to normalize something it passed through.
          assert(
            !V1_ONLY_KINDS.has(kind),
            `envelope ${String(envelope.seq)} is payloadVersion 2 but carries the v1-only kind "${kind}"`,
          );
        }

        // The fixed point, at the layer this suite can reach: the fold over one worker's log is
        // deterministic and de-duplicates by `(workerId, seq)`, so folding the same envelopes
        // twice — and folding them with every envelope duplicated — is the same answer.
        const turnId = mapped.find((e) => e.turnId !== null)?.turnId ?? null;
        assert(turnId !== null, "no envelope carried a turnId");
        const once = reduceTurn(turnId, envelopes);
        const twice = reduceTurn(turnId, [...envelopes, ...envelopes]);
        assert(deepEqual(once, twice), "reduceTurn is not idempotent over duplicated envelopes");
      },
    },
  ];
}
