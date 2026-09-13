/**
 * @omni-acp/protocol — the shapes every other package agrees on.
 *
 * FROZEN by the scaffold (M0-PLAN.md §1.2): re-export only. A work package that needs a new
 * name here is renegotiating CONTRACTS.md, not making a commit.
 */

// The single ACP-SDK re-export point (CONTRACTS.md §5.1 src/acp.ts).
export * from "./acp.js";

// Ids (D12).
export * from "./ids.js";

// Errors — one code table, one status table, one error class.
export * from "./errors.js";

// Event envelopes and worker states.
export * from "./events.js";

// Worker-facing shapes.
export * from "./worker.js";

// D5's lease wire shapes (M1).
export * from "./lease.js";

// D2's resume four-state (M1).
export * from "./resume.js";

// DESIGN §7's Runtime descriptors and the probe summary (M1).
export * from "./runtime.js";

// The one pure turn aggregator (DESIGN §5.5).
export * from "./turn.js";

// HTTP control-plane shapes and request schemas.
export * from "./control-plane.js";

// Config — zod is the source of truth; the TS types are inferred.
export * from "./config.js";
export * from "./mcp-management.js";

// The cross-package seam: every interface that crosses a package boundary (CONTRACTS.md §4).
export * from "./contracts.js";
