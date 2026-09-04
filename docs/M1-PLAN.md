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
packages/core/src/worker/worker.ts               ← ONE edit, then frozen (§1.2 seam 1 + 2)
packages/daemon/src/http/routes/{index,workers}.ts   ← the split of routes.ts; per-feature route
                                                        modules are owned by their work package
packages/daemon/src/types.ts
tests/compat/{package.json,tsconfig.json,vitest.config.ts,agents.ci.yaml,agents.local.yaml}
```

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

**Seam 2 — `SessionStrategy` is injected.** After M1, `worker.ts` never names `initialize`, `session/new`,
`session/load` or `session/resume` again: it holds a `SessionStrategy` and calls `open()` on create and
`reopen()` on wake, and its `hibernate()`/`wake()` are ~60 lines of state transition that delegate. WP‑C
owns the strategy (`worker/{session-open,wake,resume-classify,hibernate,rehydrated}.ts`). The Land step
writes the delegation and the state widening (`M0State` → `WorkerState`, `#generation`, `#replayWindow`),
then freezes `worker.ts`.

**Seam 3 — the lease needs no seam at all.** `Worker.prompt()` and `Worker.cancel()` **already** call
`lease.assertHolder(who)` as their first statement (CONTRACTS F22, `worker.ts:274` and `:369`). D5
enforcement is therefore a change to the *factory* `registry.ts` passes in, plus the epoch on `ClientRef`.
WP‑D touches **zero** core worker files. This is M0's DI paying off, and it is worth saying out loud so
nobody "helpfully" adds an interface.

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
6. **No new runtime dependency.** `node:sqlite` is a Node built-in; `pnpm-lock.yaml` is unchanged, and the
   `static` CI job's `git diff --exit-code pnpm-lock.yaml` proves it.
7. `packages/daemon/src/http/sse.ts` is byte-identical to its M0 content, and the `sse-is-unchanged`
   checksum guard is in place and passing.

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
packages/core/src/normalizer/**           normalizer.ts turn-lifecycle.ts map/** vendor/**
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
with marked synthesis, the diff rewrite, the v2 permission mapping, the vendor registry's dialects, the two
close-out ladders, and `reduceTurn`'s `verdict` / `warnings` / `deniedToolCalls` / `vendorPatch` /
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
7. **All M0 `turn-lifecycle` unit tests pass unmodified.** The six M0 arms keep their semantics exactly.
8. `verdict` never depends on agent prose; the `no-agent-prose` and `descriptor-is-the-only-branch` guards
   pass and are each demonstrated failing on a planted violation.
9. The eight named golden cases of §12.8 are green; the six generated envelope goldens pass
   `corpus:emit --check` in CI; the `.expected.json` files are hand-written.
10. `reduceTurn` is still pure, still deterministic, still de-duplicates by `(workerId, seq)`, and now
    **skips `replay: true` envelopes**.

---

### M1-WP-C — Hibernate, wake, the resume four-state, orphan reaping

**Owns exclusively**

```
packages/core/src/worker/**   MINUS worker.ts (Land-frozen)
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
registry's `lease()` façade row is Land-written and calls the injected factory.

**Description.** CONTRACTS §16: `createLease` with the fencing epoch, TTL that cannot fire mid-turn,
implicit acquire, steal with audit, `releaseForHibernate`, the `omni.lease` envelopes, the `423` body
carrying the holder, and the three-route module.

**Acceptance**

1. `runLeaseConformance` is green against the `Lease` object **and** against the HTTP surface, so the two
   cannot drift.
2. A non-holder's `prompt` / `cancel` / `hibernate` / `wake` / `DELETE` is `423` with `body.lease.holder`
   and `body.lease.epoch`.
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
packages/core/test/runtime/**
packages/daemon/src/**   MINUS index.ts and http/routes/{index,workers,lease}.ts
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

1. `runCompatSuite` is green over `agents.ci.yaml` (hermetic: the SDK example agent + ten fixtures) on
   three OSes, and **never silently empty** — `OMNI_COMPAT_REQUIRE=1` fails an empty selection.
2. **Adding an agent is a YAML edit only** — proven two ways: a test appends a fixture-agent entry to a temp
   config and runs the suite unchanged, and a second test asserts **no `.ts` file in the repository contains
   a real agent's command string**.
3. Every skip carries a **source** (`config` / `capability` / `precondition`) and a reason; a skip with no
   source **fails**; `compat-report.json` is written unconditionally and uploaded.
4. §4's acceptance script is green against `claude-acp` under `OMNI_COMPAT_REAL=1`, and the run is recorded
   in §5 in the M0 smoke's format.
5. **Reconnect loses no events**: drop the SSE at a random seq during a live turn, reconnect with `?since=`,
   and the concatenated stream is **byte-identical** to an uninterrupted observer's — run 50× with
   randomized cut points.
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
| root configs, `.github/**`, all `package.json` / `tsconfig.json` / `vitest.config.ts`, all `src/index.ts`, `packages/protocol/src/**` **except `turn.ts`**, `packages/core/src/worker/worker.ts`, `packages/daemon/src/{types.ts, http/routes/index.ts, http/routes/workers.ts}`, `tests/compat/{package.json,tsconfig.json,vitest.config.ts,agents.ci.yaml,agents.local.yaml}` | **Land (frozen)** |
| `packages/core/src/{event-log,persist}/**`, `packages/core/test/{event-log,persist}/**`, `packages/testkit/src/{event-log-conformance,tmp-persistence}.ts`, `packages/testkit/test/event-log-conformance.test.ts` | **WP‑A** |
| `packages/core/src/normalizer/**`, `packages/core/test/normalizer/**`, `packages/protocol/src/turn.ts`, `packages/protocol/test/{turn,turn-golden}.test.ts`, `packages/protocol/test/{transcripts,types}/**`, `packages/testkit/src/{corpus,wire-agent}.ts`, `packages/testkit/fixtures/agents/**`, `packages/testkit/test/fixture-agents.test.ts` | **WP‑B** |
| `packages/core/src/worker/**` (minus `worker.ts`), `packages/core/src/process/**`, `packages/core/test/{worker,process}/**` | **WP‑C** |
| `packages/core/src/lease/**`, `packages/core/test/lease/**`, `packages/daemon/src/http/routes/lease.ts`, `packages/daemon/test/http/lease.test.ts`, `packages/testkit/src/lease-conformance.ts`, `packages/client/src/lease.ts`, `packages/client/test/lease.test.ts` | **WP‑D** |
| `packages/core/src/runtime/**`, `packages/core/test/runtime/**`, `packages/daemon/src/**` (minus `index.ts` and `http/routes/{index,workers,lease}.ts`), `packages/daemon/test/**` (minus `http/lease.test.ts`), `packages/testkit/src/fake-runtime.ts` | **WP‑E** |
| `packages/client/src/**` (minus `index.ts`, `lease.ts`), `packages/client/test/**` (minus `lease.test.ts`), `packages/cli/{src,test}/**`, `tests/compat/src/**`, `tests/integration/src/**`, `packages/testkit/test/arch/**` | **WP‑F** |

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
> else adds later, with no code change. CI runs `agents.ci.yaml` (the SDK example agent + the ten testkit
> fixtures) on three OSes; the real-agent file is `OMNI_COMPAT_REAL=1`, `workflow_dispatch` only.

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

- Open an SSE stream from `w.events({ since: 0 })` on client **B** (the observer) and keep it for the whole
  step.
- `A.prompt("Create a file report.txt whose first line is exactly OMNI-M1, then read it back and tell me
  the first line.")` — a task that forces at least one `tool_call` and at least one permission request.
- Concurrently, **kill A's own stream at a randomly chosen seq** while the turn is live, then reconnect with
  `?since=<lastSeq>`.
- **Assert.** The concatenation of A's two segments is **byte-identical** to B's uninterrupted stream, and
  the `seq` sequence is `1..n` with no gaps and no duplicates. `TurnResult.stopReason === "end_turn"`;
  `toolCalls` non-empty with terminal final statuses; `changes` mentions `report.txt`; `verdict` is `"ok"`
  or `"partial"` and, if `"partial"`, `deniedToolCalls ∪ failedToolCalls` is non-empty (never a bare
  `end_turn` hiding a denial — corpus finding 7); `await w.turn(turnId)` is **deep-equal** to the
  `prompt()` return value (DESIGN §5.5, one aggregate).

**Step 3 — hibernate, forced by a small idle timeout, then prompt again.**

- `POST /v1/workers/{wid}` was created with `idleTimeoutMs: 60_000`; the suite re-creates a second worker
  with **`idleTimeoutMs: 200`** and waits for `state === "hibernated"` (budget 5 s).
- **Assert the hibernation.** `process === null`, `sessionId !== null`, `hibernatedAt !== null`,
  `supervisor.live.size` dropped by one, `lease.holder === null` (hibernate releases), and exactly one
  `omni.worker_state{state:"hibernated", reason:"hibernate"}` in the log.
- `A.prompt("What did I just ask you to create?")` — this must **auto-wake**.
- **Assert the resume outcome.** The envelope sequence is `wake` → `resumed`, the `resumed` envelope carries
  `resume.outcome === "landed"` with a `rule` and a `durationMs`, `generation === 2`, `seq` **continues**
  (no restart at 1), and every envelope inside the replay window carries `replay: true` while nothing
  outside it does. The answer references `report.txt` — proof the agent's context, not just our log,
  survived.
- **Assert the negative.** A third worker resumed against a **foreign cwd** classifies `unknown` with
  `hint: "cwd_mismatch"` and **keeps its session pointer** — never `rejected_permanent`. This case is what
  turns CONTRACTS F15's unrecorded README claim into reproducible evidence.

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
with `leaderExited === true` and the **reported** value asserted against `waitGone(pid)`;
`supervisor.live.size === 0`; no temp dir and no orphan process left on any OS.

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
   `claude-acp`'s four corpus gaps (`plan`, `agent_thought_chunk`, `current_mode_update`, a tool that fails
   on its own merits) appear as `config`/`capability` skips rather than as passes.
5. Zero orphan processes after any suite, on any OS; no `ExperimentalWarning` on stderr from a spawned child
   that opens the SQLite driver, and none at all under the memory driver.
6. No file in the repository has two owners; `pnpm-lock.yaml` is **unchanged from M0** (M1 adds no package).

### Real-agent record (to be filled at the WP‑F merge)

A one-off observation in the shape of M0-PLAN §5's smoke, recorded because M1's claim is that the daemon
**resumes** a real agent and not just a fixture. Run once on Linux against the logged-in Claude Code:
the §4 script end to end, with the resulting `ProbeSummary`, the observed `ResumeReport` (`outcome`,
`rule`, `durationMs`, `replayedEvents`), the wake latency, the `-32002` cwd-mismatch classification, and
the on-disk size of `events.db` after the run. Anything that contradicts the corpus README's findings is
recorded here and the descriptor is corrected — the README is an observation, not a spec.
