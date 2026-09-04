/**
 * @omni-acp/testkit — private, never published.
 *
 * The mechanism that makes the six M0 work packages file-disjoint: WP-4 tests against
 * `fakeSupervisor()`, WP-5's HTTP half against `stubDaemon()`, WP-3 against `fakeClock()`
 * (M0-PLAN.md §2). FROZEN by the scaffold — re-export only.
 */

export * from "./memory-stream.js";
export * from "./scripted-agent.js";
export * from "./fake-supervisor.js";
export * from "./fake-clock.js";
export * from "./seq-ids.js";
export * from "./stub-daemon.js";
export * from "./sse.js";
export * from "./process-tree.js";
export * from "./paths.js";
export * from "./event-log-conformance.js";

// ── M1 additions (CONTRACTS.md §5.7) ────────────────────────────────────────
export * from "./corpus.js";
export * from "./wire-agent.js";
export * from "./fake-runtime.js";
export * from "./tmp-persistence.js";
export * from "./lease-conformance.js";
