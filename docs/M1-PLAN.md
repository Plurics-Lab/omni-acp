# omni-acp — M1 Delivery Plan

> Companion to `docs/CONTRACTS.md` (binding shapes, now M1) and `docs/DESIGN.md` v0.8 (binding decisions).
> This document says **who builds what, in which files, and what "done" means**.
>
> M0 is done and green on `main` (978 tests, three OSes). M1's goal, from DESIGN §11:
> *Normalizer v1→v2 全量映射（turn 收尾、replay 标记、扩展方法透传）；Event Log 持久化 + `since` 重放；
> lease；hibernate / resume 四态。* Acceptance: the same SDK code behaves identically across the configured
> agents; reconnect loses no events; hibernated workers wake.

---

## 1. The Land step — run once, alone, before any work package

**The Land step is not a work package.** It is a single preparatory commit by one owner. It produces
everything that would otherwise be a guaranteed merge conflict, and it produces every new source file as a
**signature-complete stub whose body throws**, so that `pnpm -r build && pnpm -r test` is green on all three
OSes with M0's 978 tests still passing and every new test `todo`, before a single line of M1 behaviour
exists.

This is M0-PLAN §1's scaffold discipline, reused unchanged, because it is the thing that made six parallel
packages work the first time.

### 1.1 What the Land step produces

**Permanently Land-owned — frozen for the whole of M1** (nobody else ever edits these):

```
package.json  pnpm-lock.yaml  tsconfig*.json  vitest.config.ts  .github/workflows/*.yml
packages/*/package.json   packages/*/tsconfig.json   packages/*/vitest.config.ts
packages/*/src/index.ts                          ← re-export barrels, re-export-only
packages/protocol/src/{contracts,acp,ids,errors,events,worker,control-plane,config}.ts
packages/protocol/src/{lease,resume,runtime}.ts  ← NEW, types only
packages/core/src/worker/worker.ts               ← Land-edited (§1.2 seams 1 + 2), then frozen
packages/daemon/src/http/routes/{index,workers}.ts   ← the split of routes.ts; per-feature route
                                                        modules are owned by their work package
packages/daemon/src/types.ts                     ← re-export-only, like the barrels above
tests/compat/{package.json,tsconfig.json,vitest.config.ts}
```

`packages/daemon/src/types.ts` is re-export-only and stays Land-frozen, so §2's and §3's WP‑E rows
exclude it explicitly alongside `index.ts` (review R1): a daemon-internal type WP‑E needs lives in the
module that needs it, exactly as M0 already does.

`tests/compat/agents.{ci,local}.yaml` are **NOT** frozen — they are WP‑F's (review R3). WP‑F is the only
package that reads them, so freezing them buys no disjointness and costs the milestone the ability to fix
its own data. The Land step wrote both to the §18.2 schema; WP‑F edits them as the suite learns.

**Created by the Land step, then handed over permanently:** every other new `packages/**/src/**/*.ts`,
`tests/compat/src/**`, and each new `*.itest.ts`, with the exact signature from `CONTRACTS.md` §5 and a body
of `throw new OmniError("internal", "unimplemented: M1-WP-x")`, plus one `it.todo()` per acceptance bullet
below. **`packages/protocol/src/turn.ts`** is written by the Land step to its new signature (§5's M1 diff)
and then **transferred to WP‑B**, which is the only work package that may edit it — the same hand-off M0-PLAN
used for the stubs it created.

**`packages/daemon/src/{registry,create-daemon,catalog}.ts`** are likewise Land-edited to their new shape
(injected `PersistenceHandle` / `SessionStrategy`, the new façade rows, the retention timer, the adoption
call) and then **transferred to WP‑E**, which is the only owner of daemon wiring. They are not shared.

### 1.2 The three seams, named — this is what keeps the work packages disjoint

Three features (normalizer, lifecycle, lease) would all otherwise need `worker.ts`, and two would need
`registry.ts`. Each is resolved by a seam that the Land step installs once.

**Seam 1 — the close-out ladder lives in the pure reducer.** `TurnOutput` gains
`action: CloseOutAction | null`, and `worker.ts`'s coupling to the Normalizer becomes four lines:

```
const out = norm.step(input);
log.appendAll(out.emit);            // seq assigned here, synchronously, in array order
rescheduleTick(out.scheduleTickAt);
perform(out.action);                // ← the one new line
```

WP‑B owns the ladder's *decisions* (`normalizer/turn-lifecycle.ts`); `worker.ts` owns only the *performance*
of `close_stdin` / `drain` / `cancel` / `terminate`, which the Land step writes. **No `CloseOutStrategy`
interface is needed** — putting the ladder in the reducer keeps it unit-testable with `fakeClock()` and no
process, which is the whole point.

**Seam 1 has an INPUT side too, and it is Land-written** (review round 1, item 2). A ladder with no
producers is a reducer arm that can be unit-tested and can never run: `TurnInput`'s `close_requested`,
`drained` and `stderr_line` had **zero** callers, and all four of §13.2's triggers live in the frozen
file. So the Land step also wrote, in `worker.ts`:

- `#runCloseOut(budgetMs)` — feeds `close_requested` and waits for the reducer to report `settled`,
  bounded by the new optional `limits.closeOutMs` (a backstop on a reducer that never settles, never a
  rung deadline). It is called by `#doClose` (after `session/close`, before the kill, and **skipped on a
  forced close** — `force` means every cooperative rung was already offered), by `#doHibernate` (before
  the process is reclaimed) and by `cancel()`'s escalation timer (which previously jumped to rung 5 with
  rungs 1‑4 skipped);
- `drained`, fed from `#watchProcess`'s `stdoutEnded` — §13.2's "stdout EOF during rung 3";
- `stderr_line`, fed from `StderrTail.onLine` in `#openProcess` (complete lines only, unsubscribed in
  `#reclaimProcess` / `#doClose`) — §13.4's fourth signal;
- tick delivery is no longer suppressed while `#closing` if the ladder is the thing running, because the
  ladder ADVANCES on ticks.

With M0's reducer all three inputs throw `unknown turn input`; `#feedLadder` answers `null`, logs once at
debug, and every caller falls through to M0's path — which is why no M0 test moves.

**Seam 2 — `SessionStrategy` is injected.** After M1, `worker.ts` never names `initialize`, `session/new`,
`session/load` or `session/resume` again: it holds a `SessionStrategy` and calls `open()` on create and
`reopen()` on wake, and its `hibernate()`/`wake()` are ~60 lines of state transition that delegate. WP‑C
owns the strategy (`worker/{session-open,wake,resume-classify,hibernate,rehydrated}.ts`).

**Landed, and this is what "frozen" now means** (review R13). The Land step wrote, in `worker.ts`:

- `hibernate()` — §15.2's ordered transition: the synchronous `#hibernating` flag, stdin EOF then the
  graceful ladder, **no `session/close`**, `lease.releaseForHibernate()`, then the envelope. It REFUSES
  (`not_resumable`) when no resume spelling was resolved, which is ruling M1-R15's default;
- `wake()` — §15.3's ladder over private state: single-flight admission, `#openProcess()`, then ONE call
  to `this.#deps.session.reopen(link, {…, controls})` **inside** the replay window, then §15.5's mapping
  of the outcome onto `ready` / `hibernated` / `closed`, and of `maxWakeFailures` onto `wake_failed`;
- `prompt()` on a `hibernated` worker AUTO-WAKES (§15.3's first box), and the `#hibernating` window
  answers `worker_busy`;
- `start()` — the same delegation for create: `strategy.open(link, …)` when one is injected, M0's inline
  `runHandshake` when it is not, so the M0 suite runs untouched;
- the state widening (`M1State`, `#generation`, `#crashed`, `#hibernatedAt`, `#wakeFailures`,
  `#replayWindow` as a refcount) and the `AcpLinkLike` adapter a strategy is handed.

**Seam 2 is "open + reopen + RESTORE"** (review round 1, item 1). The third verb was missing: §14.8 requires
a rehydrated worker to be "the same `Worker` class constructed in a non-`starting` initial state", and the
class was neither exported nor constructible in any state but `starting`. So `worker.ts` took **one further
Land edit**:

- `class Worker` is **exported** (it is not on `@omni-acp/core`'s barrel — `createWorker` and
  `createRehydratedWorker` stay the only two ways a consumer gets a handle);
- its constructor takes an optional second argument `restore?: { row: WorkerRow }` which seeds `#state`,
  `#emittedState`, `#sessionId`, `#capabilities`, `#currentTurnId`, `#closeReason`, `#generation`,
  `#crashed`, `#hibernatedAt`, `#wakeCount`, `#wakeFailures`, `#resume`, `#orphan` and the row's
  timestamps — and, for an already-`closed` row, **pre-resolves `#closePromise` with the persisted
  `CloseResult`**, so `DELETE` after a restart replays that body byte-for-byte (§15.6 level 3) instead of
  recomputing an optimistic `treeGone`. A `closed` row with no `closeResult` (a boot that died mid-close)
  gets the deliberately pessimistic fallback §15.6 names.

Absent the argument the constructor is M0's line for line, so no M0 test moves.

WP‑C therefore writes `SessionStrategy`, `createHibernateTimer`, `attemptResume`, `classifyResume`,
`createRehydratedWorker` (which now has a class to construct, and grows `RehydrateDeps` — its own file —
into whatever `CreateWorkerDeps` a row plus the daemon's catalog cannot supply) and every test — and edits
**no** frozen file. `performWake`'s first parameter is the `AcpLinkLike`, so its signature can reach
`SessionStrategy.reopen`.

**Seam 3 — the lease needs no interface, but it does need an injection point.** `Worker.prompt()` and
`Worker.cancel()` **already** call `lease.assertHolder(who)` as their first statement (CONTRACTS F22), and
the Land step added the same first line to `Worker.wake()`. D5 enforcement is therefore a change to the
*factory* `registry.ts` passes in, plus the epoch on `ClientRef`.

**Landed** (review R14): `WorkerRegistryOptions.leaseFactory` and `DaemonDeps.leaseFactory`, with
`registry.ts` calling `o.leaseFactory?.(owner, workerId) ?? alwaysGrantedLease(owner, workerId)` at the one
construction site; `registry.delete()` calling `assertHolder` (the `423` on `DELETE` has no other home,
because `WorkerHandle.close()` takes no `ClientRef`, and **guarded by `auth.role !== "admin"`**, which is
§16.1 rule L3's other half — review round 1, item 4); and the registry's `lease()` façade row written and
dispatching acquire / release / steal onto that lease. Under the default `alwaysGrantedLease` every one of
those is M0's behaviour unchanged. WP‑D implements `createLease` in its own files; WP‑E flips the default
in `create-daemon.ts`. Neither edits the other's hunk, and WP‑D still touches **zero** core worker files —
so nobody should "helpfully" add an interface.

**And the epoch, which completes seam 3** (review round 1, item 3). The sentence above says "plus the epoch
on `ClientRef`", and that half had not landed: every link in the chain — `ClientRef`, `AuthContext`,
`auth.verify()`, `HEADER.leaseEpoch` — is frozen, so §16.1 rule L7 ("present and stale ⇒ `423`, **even from
the right client id**") was unreachable for every gated verb. Landed now:

- `ClientRef.epoch?: number` and `AuthContext.leaseEpoch: number | null`
  (`packages/protocol/src/contracts.ts`);
- `auth.verify()` parses `HEADER.leaseEpoch` — a non-numeric value is `bad_request`, because a fence the
  daemon silently ignored is worse than no fence — and `asClientRef()` spreads it in.

Every frozen signature is untouched: `prompt(content, who)`, `cancel(who)`, `wake(who, opts)` and
`assertHolder(who, opts?)` are exactly as they were, and only the VALUE gained a slot to travel in. WP‑D's
`createLease` reads `who.epoch ?? opts?.epoch` inside `assertHolder`; `alwaysGrantedLease` ignores it, so
the default is M0's behaviour unchanged.

### 1.3 Land step exit criteria

1. `pnpm -r build && pnpm -r test` green on ubuntu-latest, macos-latest **and** windows-latest, with **all
   978 M0 tests still passing**, every new body throwing and every new test `todo`.
2. `M1_WORKER_STATES` and `RESUME_OUTCOMES` are exported; `eventEnvelopeSchema` round-trips an
   `omni.lease` payload and a `worker_state` carrying `resume` + `orphan` + `crashed` + `generation`.
3. `ERROR_STATUS` is still total over `OmniErrorCode` at **compile** time, and **no code was added**.
4. `DaemonConfig.parse({tokens:[…]})` yields every new default (`hibernate`, `lease`, `probe`, `resume`,
   the six new `eventLog` fields) and an **unmodified M0 config file still parses**.
5. `@omni-acp/protocol` still imports no other `@omni-acp/*` package; the §3.1 DAG holds; the new
   `tests/compat` package is `PRIVATE` and depends on `{client, daemon, protocol, testkit}`.
6. **No new external dependency.** `node:sqlite` is a Node built-in. The only `pnpm-lock.yaml` delta from
   M0 is the new `tests/compat` workspace importer — a new workspace member always adds one, and criterion
   5 requires that member — whose entries are all `workspace:*` links plus `yaml@2.9.0`, already resolved
   for `@omni-acp/cli`. `pnpm install --frozen-lockfile` followed by the `static` CI job's
   `git diff --exit-code pnpm-lock.yaml` is clean, which is the property actually intended and actually
   checked (review R7, R20, Land note S1).
7. `packages/daemon/src/http/sse.ts` is byte-identical to its M0 content, and the `sse-is-unchanged`
   checksum guard is in place and passing.

### 1.4 What the Land step actually landed — the deviations, recorded

The Land commit is `chore: land M1 contract surface (stubs and types)` plus the review-driven amendment
`chore: apply M1 contract review findings; land seams 2 and 3`. Everything below is a place where the
landed code says something this plan or `CONTRACTS.md` did not, and it is recorded here so a work package
reads one story rather than two.

1. **Optional where the document said required, at the Land step only** (S2, S3). `createNormalizer`'s four
   M1 options (`drainGraceMs`, `cancelGraceMs`, `descriptor`, `ids`) and `CreateWorkerDeps.session` are
   OPTIONAL, because a required dependency whose only implementation throws would have taken all 978 M0
   tests with it. A caller written against CONTRACTS §5.7 compiles unchanged; WP‑B and WP‑C tighten the
   defaults away. Same pattern as M0's `CreateWorkerDeps.toSpawnSpec?`.
2. **Three bodies are REAL, not stubs, and each for a reason that would otherwise break a fixture** (S4,
   S5). `mapPermissionRequest` (ruling M1-R14 routes every permission through the v2 map before the
   responder sees it, and a throwing stub would HANG the SDK example agent mid-turn rather than fail it);
   `DEFAULT_V1_PROFILE` and `fakeRuntime()` (`Catalog.descriptor()` is documented as NEVER throwing, so a
   throwing constant would make the fallback path the one that cannot run). `BUILTIN_RUNTIMES` is still
   `[]` — WP‑E lands the claude-acp entry from §17.2.
3. **Honest placeholders, each commented in place** (S6). `WorkerSnapshot.runtimeId` is
   `"<agentId>@unresolved"` because `DEFAULT_V1_PROFILE.fingerprint` is the literal sentinel `"unresolved"`
   rather than twelve invented hex digits; `ProcessInfo.fingerprint` is `null` at spawn, which is exactly
   the value that FORBIDS signalling the pid after a restart; `AgentCapabilitiesSnapshot.resume.method` is
   `null`, so under the default `whenNotResumable:"keep"` an M0-shaped worker refuses to hibernate — the
   safe reading; `DaemonInfo.persistence` reports the memory driver's real state and `bootId` is
   per-process.
4. **`PlatformOps.fingerprint` on win32 returns `null` as FINAL behaviour** (S7), not a stub: §15.7 fixes
   it and WP‑C acceptance 7 asserts it. The POSIX one throws `unimplemented: M1-WP-C`.
5. **Two registrars register NOTHING rather than throwing** (S8): `registerLeaseRoutes` and the probe half
   of `registerAgentRoutes` are called by `createHttpApp()` on every daemon this repo builds, and a
   throwing route would answer `500` where the honest answer for an unimplemented route is today's
   `400 unknown route` (§9, D29). `GET /v1/agents` moved into `routes/agents.ts` unchanged so WP‑E can add
   H16 beside it without touching a frozen file.
6. **`routes/workers.ts` imports its helpers from `routes/index.ts`** (S9) — a module cycle in the graph
   sense only (every binding is a hoisted function declaration; registration happens inside a call). A
   fifth `params.ts` would have fallen under WP‑E's ownership per §3, so the helpers stayed in the
   Land-owned index.
7. **`ProbeOverrides` is spelled out instead of `ProbeConfig.partial().prefault({})`** (S12): `.partial()`
   only makes keys optional, so the inner `.default()`s still fire and `{}` would parse into the full
   block — an agent overlay would then silently beat the daemon-wide `probe` setting on every field the
   operator never wrote. CONTRACTS §5.1's diff now says so.
8. **`turn.ts` was Land-written and transferred to WP‑B** (S14), and `CLOSE_REASON_CODE` gained arms for
   M1's new close reasons (S13, and now CONTRACTS §5.1's `src/turn.ts` block). `TurnResult.verdict` is the
   only field the M0 fold can honestly derive today (`error === null ? "ok" : "failed"`); `warnings` /
   `failedToolCalls` / `deniedToolCalls` are `[]` and `vendorPatch` is `null` until WP‑B lands §13.4's
   promotion rules.
9. **M0 tests adapted, minimally, each with a comment saying why** (S10): the lease double (`steal` is its
   own method now), the permission-responder helper (it builds a `MappedPermissionRequest`, per M1-R14 —
   every asserted RULE is unchanged), the handshake/close tests (new snapshot fields), the protocol config
   and golden tests (new defaults, `toolCallId`, `TurnResult`'s and `FileChange`'s new fields), and the
   testkit/daemon/client doubles. **No test was weakened**; each change is a shape change the contract
   requires.
10. **Guard changes** (S11): `no-message-id` is retired and replaced by `message-id-optional`, because
    §10.2 mandates the swap — M1's map passes `messageId` through, so the old guard would forbid the
    feature; `http-has-no-logic` now scans `src/http/**` RECURSIVELY (a non-recursive scan would have gone
    silently vacuous after the routes split); and the new `sse-is-unchanged` pins `sse.ts`'s sha256.
11. **The lockfile** (S1): see §1.3 criterion 6 — one importer row, no new external package.
12. **Round 1 of the contract review took one further Land pass**
    (`docs/review/2026-09-04-m1-contract-review.md`, items 1‑8), and it is what finished the three seams
    rather than adding behaviour. In `worker.ts`: the exported `Worker` class plus the constructor's
    `restore?: { row }` argument (seam 2's third verb, §1.2), and seam 1's three producers with
    `#runCloseOut` / `#feedLadder` and the new optional `limits.closeOutMs`. In
    `packages/protocol/src/contracts.ts`: `ClientRef.epoch?` and `AuthContext.leaseEpoch`, with
    `daemon/src/auth.ts` parsing `Omni-Lease-Epoch` (seam 3's other half). In `daemon/src/registry.ts`:
    `delete()`'s admin bypass (§16.1 L3). And one **stub that §5.7 declared and the Land step missed** —
    `runEventLogPersistenceConformance` in `packages/testkit/src/event-log-conformance.ts`, now landed
    throwing `unimplemented: M1-WP-A` and added to `exports-are-stable.itest.ts`'s frozen testkit list, so
    WP‑A acceptance 2 and §14.11 have a symbol to fill. Every one of these is behaviour-neutral under the
    M0 slice, and the suite is still **980 passed / 2 skipped**.

---

## 2. Work packages

Six packages, **file-disjoint after the Land step**, running in parallel. WP‑A…WP‑E have **no dependency on
each other**: each compiles against Land stubs and testkit fakes and is unit-testable alone. WP‑F is the
join point, exactly as WP‑6 was in M0.

```
Land ──┬──► WP-A  persistence + retention
       ├──► WP-B  normalizer map + close-out + projection
       ├──► WP-C  hibernate / wake / resume four-state / orphans
       ├──► WP-D  lease
       ├──► WP-E  runtime descriptors + probe + daemon wiring
       └──────────────────────────────────────────────► WP-F  client + CLI + compat + integration
```

---

### M1-WP-A — Event-log persistence, retention, restart-survivable `?since=`

**Owns exclusively**

```
packages/core/src/event-log/**            log-core.ts memory-log.ts sqlite-log.ts retention.ts
packages/core/src/persist/**              open.ts schema.ts event-store.ts worker-store.ts
                                          persistence.ts lock.ts warning.ts
packages/core/test/event-log/**
packages/core/test/persist/**
packages/testkit/src/{event-log-conformance,tmp-persistence}.ts
packages/testkit/test/event-log-conformance.test.ts
```

**dependsOn**: none (Land only).

**Description.** M0's ring, subscribers, overflow and re-entrancy move **verbatim** into `log-core.ts`;
`memory-log.ts` becomes a thin wrapper whose behaviour and tests are unchanged. Behind it goes a
write-through `node:sqlite` backend (CONTRACTS §14): one `DatabaseSync` per `dataDir`, WAL, lazy
driver-gated import with surgical `ExperimentalWarning` suppression, `EventStore` + `WorkerStore` +
`PersistenceHandle`, the three retention bounds with a pure `planRetention()`, the digest side table, and
the data-dir lock.

**Acceptance**

1. `runEventLogConformance` passes for `memory`, `sqlite(:memory:)` and `sqlite(file)` on three OSes —
   **M0's suite verbatim and unedited, including the object-identity assertion** (F11). That is what proves
   the ring stayed.
2. `runEventLogPersistenceConformance` passes all ten items of §14.11.
3. **Item 3 fails on a planted `head = max(seq)`** — the §14.4 bug, demonstrated red during review.
4. `driver:"memory"` never loads `node:sqlite`: a test stubs `process.emitWarning` and asserts **zero**
   `ExperimentalWarning`s across a full create-worker-prompt cycle. `driver:"sqlite"` emits zero, **and** an
   unrelated `ExperimentalWarning` still gets through — both directions.
5. A `put` that throws degrades (`persistence:"degraded"`), never throws into `append`, keeps `seq`
   gap-free, still delivers to subscribers, and reaches `writeFailures`.
6. `planRetention` is pure and table-tested; `runRetention` raises `tail_seq` **in the same transaction** as
   the DELETE, never ages out a live or hibernated worker, and returns the freelist to zero after
   `incremental_vacuum`.
7. The digest cuts the corpus's 23 `available_commands_update` appends to 2 stored payloads with a
   **byte-identical `read(0)`**; an `UpdateRule` in the forbidden `stream:false, store:true` shape is
   rejected at descriptor resolution.
8. The ring/disk boundary survives a randomized append/read/evict fuzz (gap-free, no duplicates) and a
   read across the floor with the ring sized to 3.
9. The data-dir lock refuses a second live daemon naming the first's pid, breaks a stale one, and is
   **skipped entirely** for the memory driver.
10. A per-append latency budget over 5 000 appends holds on all three OSes.

---

### M1-WP-B — Normalizer full v1→v2 map, close-out ladder, turn projection

**Owns exclusively**

```
packages/core/src/normalizer/**           normalizer.ts turn-lifecycle.ts map/** vendor/dialects.ts
  MINUS vendor/registry.ts                ← WP-E's (it is the DESCRIPTOR's registry; see WP-E)
packages/core/test/normalizer/**          incl. golden/
packages/protocol/src/turn.ts             ← Land-written, transferred here; the ONLY protocol/src file
                                            any work package owns
packages/protocol/test/{turn,turn-golden}.test.ts
packages/protocol/test/transcripts/**
packages/protocol/test/types/**           the compile-time "structurally identical" assertions
packages/testkit/src/{corpus,wire-agent}.ts
packages/testkit/fixtures/agents/**       incl. the four new ones
packages/testkit/test/fixture-agents.test.ts
```

**dependsOn**: none (Land only).

**Description.** CONTRACTS §12 and §13: the three-layer split, all 29 map rows, `messageId` pass-through
with marked synthesis, the diff rewrite, the v2 permission mapping, the two vendor **dialects**
(`vendor/dialects.ts` — the `_meta` readers; the vendor REGISTRY next to it is WP-E's, review round 1
item 6), the two close-out ladders, and `reduceTurn`'s `verdict` / `warnings` / `deniedToolCalls` / `vendorPatch` /
`tokens`. Plus the corpus loader, the four gap-filling fixture agents, and the wire-replay agent.

**Acceptance**

1. Every row of §12.3 has a hand-written test with **literal** input and **literal** expected output — never
   captured from the implementation.
2. All 216 recorded updates pass the eight properties of §12.7(b), including: `mapUpdate` is idempotent and
   total; `_meta` survives **by identity**; no `tool_call` / `plan` / `current_mode_update` survives;
   `SessionUpdate.isCustom` is false for every mapped payload; content blocks are checked recursively.
3. `messageId` is synthesized **0 times** across the whole claude-acp corpus (86/86 chunks pass through) and
   **correctly** for `thought.mjs`.
4. `mapDiffBlock` produces a patch `git apply --check` accepts for the recorded **edit** and the recorded
   **creation**, executed in a temp repo inside the test; `TurnResult.patch` stays `null` and the patch
   appears only as `vendorPatch`. `skipIf(win32)` on the `git apply` assertion only.
5. `mapPermissionRequest` is idempotent, never reshapes `options`, preserves an unknown `kind`, and the
   responder **refuses** to answer with an `optionId` the agent did not offer (corpus `09`).
6. The forced ladder drives rungs 1→5 in order under `fakeClock()`, with a `usage_update` arriving mid-rung
   ordered **before** `idle` (the corpus `06` shape).
7. **The ladder runs end-to-end through a REAL `Worker`**, not only through the reducer: on a scripted
   agent, a `DELETE` (and a hibernate) walks rungs 1→5 in the log, `close_stdin` is observed by the
   fixture, `drained` arrives from the process's own stdout EOF, and a `fatalStderr` line promotes to
   `omni.error` before `idle`. Seam 1's INPUT side is Land-written (`close_requested` from `#doClose` /
   `#doHibernate` / the cancel escalation, `drained` from `#watchProcess`, `stderr_line` from
   `StderrTail.onLine`), so a ladder that passes the reducer's unit tests and cannot run in a Worker is a
   failure of this bullet, not of the Land step (review round 1, item 2).
8. **All M0 `turn-lifecycle` unit tests pass unmodified.** The six M0 arms keep their semantics exactly.
9. `verdict` never depends on agent prose; the `no-agent-prose` and `descriptor-is-the-only-branch` guards
   pass and are each demonstrated failing on a planted violation.
10. The eight named golden cases of §12.8 are green; the six generated envelope goldens pass
    `corpus:emit --check` in CI; the `.expected.json` files are hand-written.
11. `reduceTurn` is still pure, still deterministic, still de-duplicates by `(workerId, seq)`, and now
    **skips `replay: true` envelopes**.

---

### M1-WP-C — Hibernate, wake, the resume four-state, orphan reaping

**Owns exclusively**

```
packages/core/src/worker/**   MINUS worker.ts (Land-frozen; its hibernate/wake/start delegations
                              are WRITTEN — §1.2 seam 2 — so nothing here needs to touch it)
                              session-open.ts wake.ts resume-classify.ts hibernate.ts
                              rehydrated.ts handshake.ts permission-responder.ts
packages/core/src/process/**  fingerprint.ts platform.ts platform-posix.ts
                              platform-windows.ts supervisor.ts agent-process.ts spawn.ts
                              stderr-tail.ts frame-limit.ts
packages/core/test/worker/**
packages/core/test/process/**
```

**dependsOn**: none (Land only) — it tests against `fakeSupervisor()`, `scriptedAgent()` and a fake
`WorkerStore` from testkit, never against WP‑A's implementation.

**Description.** CONTRACTS §15: the `SessionStrategy`, the hibernate timer and its ordering, the wake path
with the replay window, the pure rule-numbered `classifyResume`, the rehydrated worker, process
fingerprints, and `Supervisor.reapOrphan`.

**Acceptance**

1. §15.1's state table is a table test, and all **five invariants** hold after every transition.
2. §15.4's classifier table is green, **including** the negative lock asserting `PERMANENT_TEXT` does not
   match `"Resource not found"`, and the property test "no network / timeout / auth / quota / 5xx error ever
   yields `rejected_permanent`".
3. The replay window marks exactly the updates between request and response, and is closed in a `finally`:
   a test **rejects** the resume and asserts the *next* turn's updates carry no `replay`.
4. `hibernate()` never sends `session/close` (asserted on a scripted agent that records every method),
   releases the lease, leaves `supervisor.live.size === 0`, and refuses on a non-resumable agent under the
   default `whenNotResumable:"keep"`.
5. Wake outcomes `landed` / `rejected_transient` / `rejected_permanent` / `unknown` each produce §15.5's
   HTTP code and §15.1's end state, on a scripted agent — no real agent needed. Five tests.
6. Concurrent `wake()` callers share **one** attempt (5 racing callers); `maxWakeFailures` is enforced and
   the (N+1)th prompt is `410`, not another spawn.
7. `fingerprint` is captured at spawn on Linux and darwin and is `null` on win32; `reapOrphan` sends **no
   signal** on a mismatch or a null fingerprint (spy-asserted) and the Windows branch **compiles** and
   returns `reapSkipped:"unsupported_platform"`.
8. `createRehydratedWorker` shares the `Worker` class; `close()` on a rehydrated hibernated worker returns
   `{leaderExited:true, treeGone:true, sessionClosed:false}`.
9. The deferred promotion (rule 8) fires at most once and can never overturn a `landed`.
10. `handshake.ts` resolves `resume.method` from the descriptor's preference order and captures `modes` /
    `configOptions` from `session/new` **and** from a resume body; its hard `negotiated !== 1` throw becomes
    a descriptor-driven check.

---

### M1-WP-D — Lease, fencing epoch, `423`, observer mode

**Owns exclusively**

```
packages/core/src/lease/**                lease.ts policy.ts always-granted.ts
packages/core/test/lease/**
packages/daemon/src/http/routes/lease.ts
packages/daemon/test/http/lease.test.ts
packages/testkit/src/lease-conformance.ts
packages/client/src/lease.ts
packages/client/test/lease.test.ts
```

**dependsOn**: none (Land only). **Seam 3: it touches no core worker file and no registry file** — the
registry's `lease()` façade row is Land-written and dispatches onto the lease that
`WorkerRegistryOptions.leaseFactory` produced, and `registry.delete()` already calls `assertHolder`. WP‑D
implements `createLease` and hands it to `DaemonDeps.leaseFactory`; nothing else changes.

**Description.** CONTRACTS §16: `createLease` with the fencing epoch, TTL that cannot fire mid-turn,
implicit acquire, steal with audit, `releaseForHibernate`, the `omni.lease` envelopes, the `423` body
carrying the holder, and the three-route module.

**Acceptance**

1. `runLeaseConformance` is green against the `Lease` object **and** against the HTTP surface, so the two
   cannot drift.
2. A non-holder's `prompt` / `cancel` / `hibernate` / `wake` / `DELETE` is `423` with `body.lease.holder`
   and `body.lease.epoch` — **and an admin who does not hold the lease still SUCCEEDS on `DELETE`**
   (§16.1 rule L3 is "the lease **or** `role:"admin"`", and `registry.delete()` carries the admin half
   because the lease cannot know who is asking with what authority; review round 1, item 4).
3. An observer's SSE stream receives **every** envelope of the holder's turn, including `omni.lease`.
   `attach` and `GET` are never `423`.
4. `steal` transfers, bumps the epoch, appends an audited envelope carrying `reason`, and the previous
   holder's next call is `423`.
5. A **stale `Omni-Lease-Epoch` is `423` even from the right client id**.
6. A lease never expires mid-turn: `fakeClock`, `ttlMs` shorter than the turn, `pinExpiry` refcounted, and
   a pinned lease reports `expiresAt: null`.
7. `hibernate` releases the lease; an expired lease is acquirable by anyone; every transition emits exactly
   one `omni.lease`.
8. `lease.requireClientId: true` makes a header-less gated request `400`; the default `false` keeps
   `curl-shapes.itest.ts` passing.
9. **M0's `two-workers-do-not-interfere.itest.ts` still passes untouched.**

---

### M1-WP-E — Runtime descriptors, vendor registry, probe, daemon wiring, boot adoption

**Owns exclusively**

```
packages/core/src/runtime/**              descriptor.ts known.ts merge.ts probe.ts
                                          classify.ts extensions.ts
packages/core/src/normalizer/vendor/registry.ts   ← the ONE normalizer file WP-E owns: it is
                                          keyed by descriptor and learns `-32601` per process
                                          (§17.3), and it stays under `normalizer/**` so the
                                          `descriptor-is-the-only-branch` guard keeps scanning it
packages/core/test/runtime/**
packages/daemon/src/**   MINUS index.ts, types.ts and http/routes/{index,workers,lease}.ts
                         create-daemon.ts registry.ts catalog.ts boot-recovery.ts
                         probe-service.ts probe-cache.ts event-store.ts
                         http/routes/agents.ts  http/{app,auth-middleware,sse,errors}.ts
packages/daemon/test/**  MINUS http/lease.test.ts
packages/testkit/src/fake-runtime.ts
```

**dependsOn**: none (Land only). It wires WP‑A's `PersistenceHandle`, WP‑C's `SessionStrategy` and WP‑D's
`Lease` **through Land-written stubs**, so it compiles and unit-tests before any of them land.

**Description.** CONTRACTS §17 plus all daemon wiring: `resolveDescriptor` and the single builtin, the
vendor registry with preference order and `-32601` learning, `classifyProbe` and `probeAgent`, the probe
service + on-disk cache + route, and in `create-daemon.ts` / `registry.ts`: opening persistence, taking the
lock, migrating, running boot adoption, arming the retention timer, lazy rehydration, `list()` from the
store, the hibernated counter, and the new façade rows.

**Acceptance**

1. `classifyProbe` reproduces all five corpus verdicts of §17.4, **including learning `configId` from
   `-32602 data.configId._errors`**.
2. `POST /v1/agents/{id}/probe` returns a `ProbeSummary` inside `timeoutMs`, spawns **exactly one** process
   (asserted with a counting `Supervisor`), reclaims the tree, leaves no temp dir, and `403`s a forbidden
   agent **before any process exists**. Concurrent probes of one agent share one process.
3. The cache round-trips through `<dataDir>/probes/<id>.json` at mode `0600`; `cached: true` on the second
   call; a fingerprint change invalidates. `GET /v1/agents` serves `probed` with `args` still redacted.
4. `resolveDescriptor`'s builtin ⊕ config ⊕ probe merge is table-tested; the vendor registry expresses
   preference order (`set_config_option` → `set_mode` → `set_model`) and learns `-32601` per process.
5. `createDaemon` opens persistence → takes the lock → migrates → runs boot adoption → arms retention;
   `stop()` calls `flush()` and closes the store **after** `closeAll`, so the closing envelopes reach disk.
6. Boot adoption converges every abandoned row on `hibernated` or `closed`, appends the in-band
   `omni.error` + the `daemon_restart`/`orphaned` envelope + the `omni.lease{expired}`, and is a **no-op on
   a second run**.
7. Lazy rehydration in `get()`/`delete()`; `list()` straight from the store with live entries overriding;
   hibernated workers counted separately from `maxWorkers`, and a wake that would exceed it is `429`.
8. The three new route families are **three lines each**; `http-has-no-logic` and `sse-is-unchanged` both
   pass; `423`/`422` flow through the **single existing** error mapper with no new status logic.
9. `GET /v1/info` reports `persistence`, `bootId` and `orphansAtStart` honestly, including
   `{found:n, reaped:0, skipped:n}` on Windows.
10. A migration test: empty file, v1 file (no-op), and a `schema_version` from the future ⇒ a startup
    failure **naming the version**, never a silent downgrade.

---

### M1-WP-F — Client SDK, CLI, compat suite, integration

**Owns exclusively**

```
packages/client/src/**   MINUS index.ts and lease.ts
packages/client/test/**  MINUS lease.test.ts
packages/cli/src/**      packages/cli/test/**
tests/compat/src/**      config.ts runner.ts cases.ts
tests/integration/src/**
packages/testkit/test/arch/**
```

**dependsOn**: `["M1-WP-A", "M1-WP-B", "M1-WP-C", "M1-WP-D", "M1-WP-E"]` — the join point, as WP‑6 was in
M0. Its unit half (client transport, CLI args) compiles and tests against Land stubs immediately; only the
`*.itest.ts` and compat suites need the graph resolved.

**Description.** `worker.hibernate()` / `wake()` / `lease.*` / `resume` on the SDK, the ULID
`Omni-Client-Id` and `Omni-Lease-Epoch` headers, `stream()` filtering `replay` by default,
`omni-acp probe|agents|workers`, the config-driven compat suite (CONTRACTS §18), and the M1 integration
files.

**Acceptance**

1. `runCompatSuite` is green over `agents.ci.yaml` (hermetic: the SDK example agent + the **eight
   turn-completing fixtures**; `crash` and `orphan` are excluded, because neither completes a turn) on
   three OSes, and **never silently empty** — `OMNI_COMPAT_REQUIRE=1` fails an empty selection.
2. **Adding an agent is a YAML edit only** — proven two ways: a test appends a fixture-agent entry to a temp
   config and runs the suite unchanged, and a second test asserts that **no `.ts` file in the repository
   contains the launch argv from `agents.local.yaml`** — the joined `npx -y
   @agentclientprotocol/claude-agent-acp@0.73.0` command line. The guard is scoped to the LAUNCH SPELLING,
   not to the agent's name: CONTRACTS §17.2 requires `BUILTIN_RUNTIMES` to ship a claude-acp profile whose
   matcher is `agentInfo.name /^claude-(code|agent)-acp$/`, so `packages/core/src/runtime/known.ts` will
   legitimately contain that substring and is exempted by name (review R19).
3. Every skip carries a **source** (`config` / `capability` / `precondition`) and a reason; a skip with no
   source **fails**; `compat-report.json` is written unconditionally and uploaded.
4. §4's acceptance script is green against `claude-acp` under `OMNI_COMPAT_REAL=1`, and the run is recorded
   in §5 in the M0 smoke's format.
5. **Reconnect loses no events**: drop the SSE at a random seq during a live turn, reconnect with `?since=`,
   and the concatenated stream's **envelope frames** — the `id:`/`event:`/`data:` triples — are identical to
   an uninterrupted observer's, with `: hb` comments and the `retry:` / `omni.stream_truncated` /
   `_overflow` / `_end` control frames excluded and asserted SEPARATELY (segment 2 starts with `retry:` and
   may carry one `stream_truncated`). Run 50× with randomized cut points. A raw byte comparison is
   unachievable against the checksum-frozen `sse.ts`, which writes a `retry:` preamble on every stream and
   heartbeats on a phase two connections do not share (review R12).
6. **Hibernated workers wake**: `hibernate-wake.itest.ts` with `idleTimeoutMs: 200` against the SDK example
   agent (`loadSession: true`).
7. `restart-survives.itest.ts`: prompt, `stop()`, `createDaemon()` on the same `dataDir`, `?since=<mid>`
   returns the exact tail with the same `seq`, and a hibernated worker is adopted with `generation`
   preserved.
8. `orphan-recovery.itest.ts`: a daemon in a **child process** with `orphan.mjs`, `SIGKILL`ed; the marker
   file keeps growing (the orphan really survived); on restart `orphansAtStart.found === 1` and, on Linux,
   `reaped === 1` with the marker stopping inside 2 s. `skipIf(win32)` on the reap half only — **the record
   half runs everywhere**.
9. `lease.itest.ts`: two SDK clients, one token, distinct client ids — observer streams the holder's whole
   turn while its own `prompt` is `423`; `steal` transfers and the first client's next call is `423`.
10. `exports-are-stable.itest.ts` updated for every new barrel name; the `message-id-optional`,
    `no-agent-prose`, `descriptor-is-the-only-branch`, `normalizer-is-pure` and `sse-is-unchanged` guards
    are green; three-OS CI green.

---

## 3. Ownership map (no path appears twice)

| Path | Owner |
| ---- | ----- |
| root configs, `.github/**`, all `package.json` / `tsconfig.json` / `vitest.config.ts`, all `src/index.ts`, `packages/protocol/src/**` **except `turn.ts`**, `packages/core/src/worker/worker.ts`, `packages/daemon/src/{types.ts, http/routes/index.ts, http/routes/workers.ts}`, `tests/compat/{package.json,tsconfig.json,vitest.config.ts}` | **Land (frozen)** |
| `packages/core/src/{event-log,persist}/**`, `packages/core/test/{event-log,persist}/**`, `packages/testkit/src/{event-log-conformance,tmp-persistence}.ts`, `packages/testkit/test/event-log-conformance.test.ts` | **WP‑A** |
| `packages/core/src/normalizer/**` (minus `vendor/registry.ts`), `packages/core/test/normalizer/**`, `packages/protocol/src/turn.ts`, `packages/protocol/test/{turn,turn-golden}.test.ts`, `packages/protocol/test/{transcripts,types}/**`, `packages/testkit/src/{corpus,wire-agent}.ts`, `packages/testkit/fixtures/agents/**`, `packages/testkit/test/fixture-agents.test.ts` | **WP‑B** |
| `packages/core/src/worker/**` (minus `worker.ts`), `packages/core/src/process/**`, `packages/core/test/{worker,process}/**` | **WP‑C** |
| `packages/core/src/lease/**`, `packages/core/test/lease/**`, `packages/daemon/src/http/routes/lease.ts`, `packages/daemon/test/http/lease.test.ts`, `packages/testkit/src/lease-conformance.ts`, `packages/client/src/lease.ts`, `packages/client/test/lease.test.ts` | **WP‑D** |
| `packages/core/src/runtime/**`, `packages/core/src/normalizer/vendor/registry.ts`, `packages/core/test/runtime/**`, `packages/daemon/src/**` (minus `index.ts`, `types.ts` and `http/routes/{index,workers,lease}.ts`), `packages/daemon/test/**` (minus `http/lease.test.ts`), `packages/testkit/src/fake-runtime.ts` | **WP‑E** |
| `packages/client/src/**` (minus `index.ts`, `lease.ts`), `packages/client/test/**` (minus `lease.test.ts`), `packages/cli/{src,test}/**`, `tests/compat/src/**`, `tests/compat/agents.{ci,local}.yaml`, `tests/integration/src/**`, `packages/testkit/test/arch/**` | **WP‑F** |

Every path not listed keeps its M0 owner and its M0 content; an M1 work package that needs one edited files
a request to the Land owner rather than editing it.

Guard tests live with their owner: `seq-single-writer` (extended) → WP‑A; `no-agent-prose`,
`descriptor-is-the-only-branch`, `normalizer-is-pure` → WP‑B; `no-direct-spawn` (extended to
`runtime/probe.ts`) → WP‑C; `http-has-no-logic` and `sse-is-unchanged` → WP‑E; `message-id-optional`,
`client-has-no-daemon-import`, `exports-are-stable`, `sdk-version-pinned`, `dependency-direction` → WP‑F.

---

## 4. The M1 acceptance script

`tests/compat/src/runner.ts`, driven by `agents.yaml`. **For each configured agent** — today exactly one,
`claude-acp` — the identical script runs. An agent that is not configured on this machine is **skipped with
a printed source and reason**, never silently passed, and `OMNI_COMPAT_REQUIRE=1` turns an empty selection
into a failure.

> **Real-agent runs use `claude-acp` only.** It is the only ACP agent installed here
> (`npx -y @agentclientprotocol/claude-agent-acp@0.73.0`, logged-in Claude Code). `codex-acp`, `gemini`,
> `opencode` and `kimi` are **not installed and must not be installed**; they are YAML entries somebody
> else adds later, with no code change. CI runs `agents.ci.yaml` (the SDK example agent + the **eight
> turn-completing** testkit fixtures; `crash` and `orphan` are excluded) on three OSes; the real-agent file
> is `OMNI_COMPAT_REAL=1`, `workflow_dispatch` only.

**Setup.** `mkdtemp` workspace under `os.tmpdir()`, registered as the token's only `cwdRoot`.
`createDaemon({ listen: {host:"127.0.0.1", port:0}, dataDir: <mkdtemp>, eventLog: { driver: "sqlite" },
hibernate: { idleMs: 60_000 }, tokens: [<admin>, <second user token on the same cwdRoot>],
agents: [<the YAML entry, resolved for this platform>] })`, `daemon.start()`, then **two** clients:
`A = OmniACP.connect({ token, clientId: <ulid> })` and `B = OmniACP.connect({ token, clientId: <other ulid> })`.

**Step 0 — probe.** `A.probe(agentId)` once. Its `ProbeSummary` drives every `capability` skip below, so a
missing capability is reported as a skip rather than a failure.

**Step 1 — create.** `w = A.createAgent(agentId, { cwd, idleTimeoutMs: 60_000 })`.
Assert `state === "ready"`, `capabilities.raw` non-empty, `runtimeId` stable across two workers,
`lease.holder.clientId === A`, `generation === 1`, `persistence === "durable"`.

**Step 2 — a tool-using turn, interrupted and resumed mid-flight.**

> **M1 has exactly one wired permission responder and it is auto-DENY** (`create-daemon.ts` hard-defaults
> `createBaselineResponder("deny")`; `CreateWorkerRequest.onUnresolved` accepts only `"deny"`; the policy
> engine is M2, CONTRACTS §2.3). So this step asserts what a denial actually looks like on the wire, which
> is corpus `04`'s recorded outcome, rather than a write that cannot happen (review R11).

- Open an SSE stream from `w.events({ since: 0 })` on client **B** (the observer) and keep it for the whole
  step.
- **Turn 2a, read-only** — `A.prompt("List the files in this directory and tell me how many there are.")`.
  Reads are auto-allowed (corpus `02`), so this turn needs no permission answer.
  **Assert.** `stopReason === "end_turn"`, `verdict === "ok"`, `toolCalls` non-empty with terminal final
  statuses, and `changes` **matches the workspace** — empty, for a turn that wrote nothing.
- **Turn 2b, a denied write** — `A.prompt("Create a file report.txt whose first line is exactly OMNI-M1.")`,
  a task that forces at least one `tool_call` and at least one permission request.
  **Assert the denial is VISIBLE**, exactly as CONTRACTS §18.4's `permission-deny` case specifies:
  `verdict === "partial"`, `deniedToolCalls` **non-empty**, `changes` **empty**, the workspace still has no
  `report.txt`, and `stopReason === "end_turn"` — the whole point being that a bare `end_turn` must never
  hide a denial (corpus findings 6, 7). The tool call's final status is `failed` with the agent's own
  `rawOutput` preserved.
- Concurrently with 2b, **kill A's own stream at a randomly chosen seq** while the turn is live, then
  reconnect with `?since=<lastSeq>`.
- **Assert the reconnect.** The concatenation of A's two segments, **compared over envelope frames only**
  (the `id:`/`event:`/`data:` triples; `: hb` comments and the `retry:` / `omni.stream_truncated` /
  `_overflow` / `_end` control frames excluded), is identical to B's uninterrupted stream, and the `seq`
  sequence is `1..n` with no gaps and no duplicates. The control frames are asserted separately: segment 2
  begins with `retry:` and may carry one `omni.stream_truncated`. A RAW byte comparison is unachievable —
  `sse.ts` is frozen by checksum and writes a `retry:` preamble on every stream (review R12).
- **Assert the aggregate.** For each turn, `await w.turn(turnId)` is **deep-equal** to the `prompt()`
  return value (DESIGN §5.5, one aggregate).

> If a future milestone wants an ALLOWED write here, it is one line and it must be labelled: add
> `@omni-acp/core` to `tests/compat/package.json` and pass
> `deps.responder = createBaselineResponder("allow", clock)` in §4's setup — a test-only seam, never a
> default.

**Step 3 — hibernate, forced by a small idle timeout, then prompt again.**

- `POST /v1/workers/{wid}` was created with `idleTimeoutMs: 60_000`; the suite re-creates a second worker
  with **`idleTimeoutMs: 200`**, sends it ONE small prompt — `"Remember the token OMNI-M1 and reply OK."` —
  and only then waits for `state === "hibernated"` (budget 5 s). The prompt is not decoration: a worker
  whose session was opened by `session/new` and never prompted has **nothing to recall**, and corpus `07`
  confirms replay carries only conversational content (review R16).
- **Assert the hibernation.** Read the worker's `process.pid` from its snapshot BEFORE the wait, then:
  `process === null`, `sessionId !== null`, `hibernatedAt !== null`, `await waitGone(pid)` — the process
  really went away, not merely the daemon's reference to it — `lease.holder === null` (hibernate
  releases), and exactly one `omni.worker_state{state:"hibernated", reason:"hibernate"}` in the log.
  Not `supervisor.live.size`: `createSupervisor` lives in `@omni-acp/core`, which `tests/compat` does not
  depend on, and `createDaemon` builds its supervisor internally and never exposes it — so that assertion
  was unreachable from this suite (review round 1, item 5). `waitGone` / `isAlive` are testkit exports the
  suite already has, and a dead pid is strictly stronger evidence than a shrunken map.
- `A.prompt("What token did I ask you to remember?")` — this must **auto-wake**.
- **Assert the resume outcome.** The envelope sequence is `wake` → `resumed`, the `resumed` envelope carries
  `resume.outcome === "landed"` with a `rule` and a `durationMs`, `generation === 2`, `seq` **continues**
  (no restart at 1), and every envelope inside the replay window carries `replay: true` while nothing
  outside it does. The answer echoes `OMNI-M1` — proof the agent's context, not just our log, survived.
- **Assert the negative, in the two places it is actually reachable** (review R17). A worker's cwd is fixed
  at creation and there is no API to resume an existing pointer under a different one, so this is not
  drivable through `Worker.wake()`:
  1. a **unit regression lock** on the pure `classifyResume`, fed the README's recorded `-32002`
     `{message:"Resource not found: <sessionId>"}` shape: `unknown`, `hint: "cwd_mismatch"`, pointer
     **kept**, plus the companion assertion that `PERMANENT_TEXT` does **not** match `"Resource not
     found"` (CONTRACTS §15.4);
  2. a compat case `resume-cwd-mismatch` driven at the **probe layer** — a second throwaway process that
     sends the descriptor's resume spelling with a deliberately foreign cwd, which is exactly how the
     corpus recorder produced transcripts `07`/`08`. That is what turns F15's unrecorded README claim into
     reproducible evidence.

**Step 4 — lease steal from a second client.**

- `B.attach(w.id)` succeeds and B's stream is still flowing (observer mode is never gated).
- `B.prompt("hello")` ⇒ `423 lease_held`, and the error body names A: `body.lease.holder.clientId === A`,
  `body.lease.epoch === e`.
- `B.lease.steal("compat suite")` ⇒ `200` with `epoch === e + 1`, and an `omni.lease{op:"stolen",
  reason:"compat suite"}` envelope in the log carrying both the previous and the new holder.
- `A.prompt("…")` now ⇒ `423`, **and** so does A's next call sent with its cached `Omni-Lease-Epoch: e`
  — the fencing check, which is the difference between a lease and a hint.
- `B.prompt("Say OK.")` succeeds.

**Step 5 — restart.** `daemon.stop()`, then `createDaemon()` on the **same `dataDir`**.
`GET /v1/workers/{wid}/events?since=<mid>` returns the same envelopes with the same `seq`; the hibernated
worker is adopted with `generation` preserved; a `DELETE` of the already-closed worker returns the
**persisted** `CloseResult` byte-for-byte.

**Step 6 — teardown.** Every worker closed; on POSIX `treeGone === true`, on Windows `treeGone === false`
with `leaderExited === true` and the **reported** value asserted against `waitGone(pid)`; every worker's
final snapshot has `process === null` and every pid the script recorded answers `waitGone`, which is the
observable form of "no process is left" (`supervisor.live.size` is not reachable from `tests/compat` —
review round 1, item 5); no temp dir and no orphan process left on any OS.

**Companion integration files** (M0's set, plus M1's):

| File | Proves |
| ---- | ------ |
| *(all M0 files)* | still green, unmodified — the compatibility bar for the milestone |
| `event-log-restart.itest.ts` | §14.4/§14.8: `?since=` across a real `stop()`/`createDaemon()`, including after a total eviction |
| `hibernate-wake.itest.ts` | `idleTimeoutMs: 200` against the SDK example agent; the `hibernate → wake → resumed` envelope order |
| `orphan-recovery.itest.ts` | a `SIGKILL`ed daemon in a child process; the orphan is **recorded everywhere** and **reaped only on Linux/macOS** |
| `lease.itest.ts` | observer mode, `423` bodies, steal, the epoch fence |
| `restart-delete-idempotent.itest.ts` | the persisted `CloseResult`, byte-for-byte, across a restart |
| `datadir-lock.itest.ts` | a second daemon on one `dataDir` fails naming the first's pid; a stale lock is broken |
| `probe.itest.ts` | one process, tree reclaimed, cache hit on the second call, `403` before any spawn |

**Budget.** The SDK example agent is ~5 s per turn; claude-acp is ~1.5 s warm handshake plus 3–7 s per turn
(corpus finding 15). The full real-agent script is ~90 s for one agent. Integration and compat
`testTimeout: 120_000`, `retry: 1`.

---

## 5. Definition of done for M1

1. `pnpm -r build && pnpm -r test` green on ubuntu-latest, macos-latest and windows-latest, with **all 978
   M0 tests still passing unmodified**.
2. Every acceptance bullet in §2 passes, and every architecture guard in `CONTRACTS.md` §10.2 passes — with
   the `seq = max(seq)` regression (WP‑A #3), `no-agent-prose` and `descriptor-is-the-only-branch` each
   **demonstrated failing on a planted violation**.
3. The §4 script is green over `agents.ci.yaml` on three OSes, and green over `agents.local.yaml`
   (`claude-acp`) on Linux under `OMNI_COMPAT_REAL=1`, with the run recorded below in the M0 smoke's format.
4. `compat-report.json` shows **zero unexplained skips**: every skip has a source and a reason, and
   **every row of `claude-acp`'s `unverified` list in CONTRACTS §17.2** — which is the single source of
   truth for its corpus gaps (review R8) — appears as a `config`/`capability` skip rather than as a pass.
   `agents.local.yaml` restates that same list and never a shorter one.
5. Zero orphan processes after any suite, on any OS; no `ExperimentalWarning` on stderr from a spawned child
   that opens the SQLite driver, and none at all under the memory driver.
6. No file in the repository has two owners; `pnpm-lock.yaml` gains **no new external package** — the only
   diff from M0 is the `tests/compat` workspace importer row, and CI's `git diff --exit-code
   pnpm-lock.yaml` after `pnpm install --frozen-lockfile` proves no work package rewrote it (review R20).

### Real-agent record

A one-off observation in the shape of M0-PLAN §5's smoke, recorded because M1's claim is that the daemon
**resumes** a real agent and not just a fixture.

Run on Linux (node 22.23.2) on **2026-09-04**, against the logged-in Claude Code, agent command
`npx -y @agentclientprotocol/claude-agent-acp@0.73.0`, launched with the daemon's own environment (the
catalog's `toSpawnSpec`, §5.4) so the adapter finds the existing login. Driver `sqlite`, two SDK clients on
one token, workspace and `dataDir` both `mkdtemp`.

```
OMNI_COMPAT_REAL=1 OMNI_COMPAT_CONFIG=agents.local.yaml OMNI_COMPAT_REQUIRE=1 \
  pnpm --filter @omni-acp/compat-tests test
```

#### Result: green, twice

| run | at | passed | failed | skipped | wall |
| --- | -- | ------ | ------ | ------- | ---- |
| 1 | 07:16:40Z | 13 | 0 | 4 | 62.4 s |
| 2 | 07:18:43Z | 13 | 0 | 4 | 57.5 s |

Per case, run 1 / run 2, in milliseconds:

| case | 1 | 2 | | case | 1 | 2 |
| ---- | - | - |-| ---- | - | - |
| `handshake` | 3608 | 3839 | | `hibernate-wake` | 10232 | 9752 |
| `plain-turn` | 2701 | 2659 | | `resume-cwd-mismatch` | 3857 | 3980 |
| `tool-turn` | 5591 | 5666 | | `lease` | 7153 | 7166 |
| `stream-resume` | 2443 | 2278 | | `restart-survives` | 595 | 554 |
| `cancel-late-update` | 4729 | 4694 | | `unknown-method` | 5 | 5 |
| `tool-merge` | 5623 | 5590 | | `idempotent-map` | 154 | 156 |
| `permission-deny` | 13866 | 8941 | | | | |

**Every skip, with its source** — there are four, all `config`, and they are §18.2's own rows for this
agent's corpus gaps. The runner reports a declared skip whose case this suite does not implement under its
own name anyway, so M1-PLAN's "the four corpus gaps stay visible in every run" is literally true of
`compat-report.json` rather than a claim about a file nobody prints:

| case | source | reason |
| ---- | ------ | ------ |
| `plan-update` | config | no todo/plan tool in this build; two deliberate attempts produced no `plan` (corpus 05/05b) |
| `agent-thought` | config | not emitted at default effort (corpus) |
| `current-mode-update` | config | `session/set_mode` answers with the v2 `config_option_update` (corpus 08) |
| `git-patch` | config | diff blocks are widened fragments; `structuredPatch` is a vendor extension (F19) |

No `capability` and no `precondition` skips: the probe reports a resume spelling, so both resume cases RAN,
and `provides: [tools, permission, cancel]` is satisfied by the corpus rows 02 / 04 / 14. Zero agents were
skipped at selection.

#### Step 0 — the `ProbeSummary`

2.24 s, one process, `cached: true` on the second call. `runtimeId` = `claude-acp@7c8f2ec1ff53`.

```json
{
  "agentInfo": { "name": "@agentclientprotocol/claude-agent-acp", "title": "Claude Agent", "version": "0.73.0" },
  "protocolVersion": 1,
  "resumeMethod": "session/resume",
  "supportedMethods": ["session/set_mode", "session/set_config_option", "session/list",
                       "session/resume", "session/load", "session/close"],
  "unsupportedMethods": ["session/set_model", "session/set_options"],
  "learnedParams": { "session/set_mode": "modeId", "session/set_config_option": "configId",
                     "session/resume": "cwd", "session/load": "cwd" },
  "timings": { "initialize": 976, "session/new": 1063, "session/set_model": 28,
               "session/set_options": 2, "session/set_mode": 6, "session/set_config_option": 5,
               "session/list": 88, "session/resume": 3, "session/load": 1,
               "omni/definitely_unknown_method": 1, "session/close": 8, "total": 2191 }
}
```

Three things in there are worth naming, because each one is a §17 claim the probe was built to settle:

1. **F17 reproduced.** `session/set_config_option` answered `-32602` with `data.configId._errors`, and the
   probe learned the field is `configId` and not `optionId` — the row §17.4 exists for.
2. **The corpus's `-32601` pair holds** (`session/set_model`, `session/set_options`), and `session/set_mode`
   is live and answers `-32602` naming `modeId`. §17.3's preference order
   (`set_config_option` → `set_mode` → `set_model`) is the right way round for this build.
3. **`session/load` AND `session/resume` are both implemented on one process** — F18, confirmed live —
   which is why the descriptor carries a preference ORDER rather than one name per capability.

#### Steps 1-3 — create, turn, hibernate, wake

| step | observed |
| ---- | -------- |
| create (spawn + `initialize` + `session/new`) | **1.82 s** warm |
| turn 1, `"Remember the token OMNI-M1 and reply OK."` | **4.54 s**, `verdict: "ok"`, `stopReason: "end_turn"`, text `"OK"` |
| `idleTimeoutMs: 400` fires → `hibernated` | **0.96 s** after the turn; `process: null`, `waitGone(pid)` true, `lease.holder: null` |
| turn 2 on a hibernated worker (auto-wake + turn) | **6.63 s** total, of which the resume itself was **1.82 s** |

The `ResumeReport` the wake recorded:

```json
{ "outcome": "landed", "hint": "ok", "rule": "rule7:landed", "method": "session/resume",
  "requested": "59921f25-cd02-43f9-8f5c-1fa403fb8433",
  "landedOn":  "59921f25-cd02-43f9-8f5c-1fa403fb8433",
  "historyLost": false, "acp": null,
  "replayedEvents": 0, "replayDropped": 0, "durationMs": 1819 }
```

`generation` went 1 → 2, `seq` continued (no restart at 1), `persistence: "durable"`, and the agent
answered turn 2 with **`OMNI-M1`** — which is the point of the whole exercise: the AGENT's model context
survived, not merely our log.

**Two observations that CONTRADICT the corpus README, recorded here rather than smoothed over.**

1. **`replayedEvents: 0`.** F16 measured `session/load` replaying the conversation as `session/update`
   notifications between the request and its response. `session/resume` — the spelling the descriptor
   PREFERS, and the one the probe selects — replays **nothing** on 0.73.0: the context is restored inside
   the agent and the client is told nothing about it. The daemon is correct either way (the replay window is
   opened around the call and closes empty), and D6's marking is still exercised hermetically by
   `fixture-hybrid`, whose `session/resume` does replay. **The descriptor is not changed**: `replayFrom` is
   already `false` for this runtime and the map's behaviour does not depend on the count. What changes is
   the expectation — a `landed` resume with `replayedEvents: 0` is normal for claude-acp, and a future
   reader should not treat a zero as a broken window.
2. **`events.db` is 4 KB on disk and 96 KB by `GET /v1/info`.** Both numbers are true: WAL mode keeps the
   recent pages in `events.db-wal` until a checkpoint, so a `statSync` immediately after a run sees only the
   header page while the daemon's own accounting sees the whole database. `DaemonInfo.persistence.sizeBytes`
   is the one to read; a bare `ls -l events.db` under-reports by an order of magnitude and is not evidence
   that nothing was written. (`writeFailures: 0`, `schemaVersion: 1`, `retentionDays: 7`.)

#### The `-32002` cwd mismatch — F15, reproduced live for the first time

F15 recorded this shape in the corpus README and in **no committed transcript**. Driven at the probe layer
(§4 step 3's second half: a throwaway process opens a session in one directory and a second one asks to
resume it from another), 0.73.0 answers:

```json
{ "code": -32002,
  "message": "Resource not found: f47bbc46-e452-4371-baf6-b3c64473a5f4",
  "data": { "uri": "f47bbc46-e452-4371-baf6-b3c64473a5f4" } }
```

`classifyResume` puts that at **rule 4 → `unknown` / `hint: "cwd_mismatch"`, pointer KEPT** — the
`isResourceNotFoundShape` arm matches on both halves (the message text and `data.uri` with `-32002`), and
`PERMANENT_TEXT` deliberately does not match it. Ruling M1-R6 chose `unknown` over `rejected_transient` for
exactly this: the pointer survives, the session is still alive, and only the request was wrong.

#### What this run does NOT establish

DESIGN §11's criterion is "同一份 SDK 代码对五个 v1 目标 agent 行为一致", and **one** real agent cannot
falsify it. §11.6 already records that. What this run does establish is that the identical script — the same
thirteen cases, the same assertions, no branches — is green against `claude-acp` and against nine hermetic
agents, and that adding the tenth is a YAML edit (`tests/compat/README.md`).
