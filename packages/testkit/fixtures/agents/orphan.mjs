#!/usr/bin/env node
// Fixture agent: orphan — Tier-2 (a real process, real ndJSON over real pipes).
// STUB. WP-1 implements it; see CONTRACTS.md §5.2 for the behaviour this name promises.
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
process.stderr.write("fixture agent 'orphan' is unimplemented: WP-1\n");
process.exit(70); // EX_SOFTWARE — an unmistakable "not built yet", never a plausible agent exit.
