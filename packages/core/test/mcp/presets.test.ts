import { describe, it } from "vitest";

/**
 * M2-B-WP-S's acceptance script (docs/M2-PLAN.md §2), one `it.todo` per bullet.
 *
 * Owned by M2-B-WP-S.
 */

describe("M2-B-WP-S — MCP presets, mcpCapabilities filtering, per-worker env, prompt containment", () => {
  it.todo(
    "a client can name a preset and CANNOT express a command: the type is string[], the client-never-sends-a-command guard passes on both halves, an unknown name is 400 NAMING it and a disallowed one is 403",
  );
  it.todo(
    "§12.3 row 22's MCP `type` injection is exercised end to end for the first time, and toleratesOmittedMcpCapabilities decides the absent-block case FROM THE DESCRIPTOR, never from an agent-id branch",
  );
  it.todo(
    "filterMcpCapabilities never filters stdio (v1 has no stdio bit, and codex advertises {acp:false, http:true, sse:false} while happily taking stdio); an unusable http preset lands as applied:[] / dropped:[{name,reason}] on the snapshot plus a TurnWarning, not as an error",
  );
  it.todo(
    "resolveWorkerEnv REJECTS with a 400 naming the key for every ENV_DENY_EXACT entry and every ENV_DENY_PREFIX; envDeny extends and PROVABLY CANNOT shrink the hard list; envAllow is enforced; invalid key names, NUL values and an over-sized map are 400",
  );
  it.todo(
    'BOTH platform branches are tested: {"path": "..."} is rejected on win32 and accepted on linux, by INJECTING platform rather than skipping',
  );
  it.todo(
    "WorkerSnapshot.envKeys carries names only, and a grep test asserts NO env value appears in any snapshot, log line or HTTP body across a full create-prompt-close cycle; requested env layers ON TOP of the descriptor's and never overwrites it",
  );
  it.todo(
    'env.persist:false forces resume.method: null; the worker refuses to hibernate under whenNotResumable:"keep" and the reason says why; a wake whose preset vanished from config closes with acl_revoked, matching §15.5\'s 403 row',
  );
  it.todo(
    "assertPromptContent rejects, BEFORE the prompt is sent: a resource_link outside cwdRoots; a symlink inside cwd that realpaths outside; a relative or non-file:// uri; a `..` traversal; an embedded resource block failing any of the above; and a block type promptCapabilities does not advertise — and in EVERY case the fixture agent recorded ZERO session/prompt calls (F37, F38), with the path elided from the message",
  );
  it.todo(
    "the M0 text-only path still works and curl-shapes.itest.ts's widened case documents the new rule",
  );
});
