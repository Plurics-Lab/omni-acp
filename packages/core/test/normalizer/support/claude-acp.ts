import { fakeRuntime } from "@omni-acp/testkit";
import type { RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * CONTRACTS.md §17.2's claude-acp descriptor, transcribed field for field.
 *
 * It lives in M1-WP-B's TEST tree rather than in `core/src/runtime/known.ts` because
 * `BUILTIN_RUNTIMES` is M1-WP-E's file and is still empty; the corpus goldens cannot wait for it,
 * and duplicating the table here is how the map is tested against the descriptor §17.2 specifies
 * rather than against one this work package invented for itself. When WP-E lands the builtin, the
 * two must agree — `descriptor.test.ts` in WP-E's tree is the place that will say so, and
 * M1-WP-B's hand-off note names this file as the transcription to diff against.
 *
 * Every value below is an OBSERVATION from the corpus. Nothing is aspirational.
 */
export function claudeAcpDescriptor(): RuntimeDescriptor {
  return fakeRuntime({
    id: "claude-acp",
    fingerprint: "corpus0730000000",
    // F24: it ANSWERS 1 and speaks v2 in places, which is why no mapping rule reads this field.
    protocolVersion: 1,
    source: "builtin",
    prefer: {
      // F18: both work, on one process.
      resume: { spellings: ["session/resume", "session/load"], onFailure: "fail" },
      // F18: `session/set_model` is -32601 HERE, so it comes last rather than not at all.
      setConfig: {
        spellings: ["session/set_config_option", "session/set_mode", "session/set_model"],
        onFailure: "fail",
      },
      // -32601 in transcript 08. A vendor extension we offered, so a WARNING (review R2).
      setOptions: { spellings: ["session/set_options"], onFailure: "warn" },
      list: { spellings: ["session/list"], onFailure: "fail" },
      close: { spellings: ["session/close"], onFailure: "fail" },
    },
    // This agent spells `session/update` the standard way (review R4).
    inboundAliases: {},
    quirks: {
      // README §10 — NOT in the committed transcripts (F15); the compat suite re-observes it.
      resumeRequiresSameCwd: true,
      resumeSilentlyCreates: false,
      loadReturnsBody: true, // F18
      diffIsFragment: true, // F19 — the flag that stops a consumer corrupting the file
      messageIdPresent: true, // F14
      toolCallUpdateIsSparse: true, // corpus finding 3
      permissionRequestShape: "v1_tool_call",
      // No `allow_session` here ⇒ `allow_once` is the only safe allow (D4 rule 2).
      sessionGrantKind: "none",
      emitsUsageUpdateOnV1: true,
      emitsStateUpdate: false,
      configIdField: "configId", // F17 — learned from -32602 data.configId._errors
      toleratesOmittedMcpCapabilities: true,
      unknownMethodErrorCode: -32601,
    },
    extensions: {
      patch: {
        pointer: "/claudeCode/toolResponse",
        as: "patch",
        dialect: "claude_structured_patch",
      },
      // `~1` is RFC-6901 for a literal "/" in the key `_claude/rateLimit`.
      rateLimit: {
        pointer: "/_claude~1rateLimit",
        as: "rate_limit",
        dialect: "claude_rate_limit",
      },
    },
    updates: {
      // F13, §14.6: 87.8 % of update bytes, 23 notifications, 2 distinct payloads.
      available_commands_update: { map: null, stream: true, store: true, digest: true },
    },
    errorRules: [
      {
        id: "bad-config-value",
        code: -32603,
        dataPointer: "/details",
        dataMatches: "^Invalid value for config option ",
        classify: "bad_request",
      },
      { id: "unknown-method", code: -32601, dataPointer: "/method", classify: "unsupported_method" },
    ],
    unverified: [
      "plan",
      "agent_thought_chunk",
      "current_mode_update",
      "mcp",
      "image_content",
      "authenticate",
      "tool_failure_on_merits",
    ],
  });
}

/**
 * The `session/new` body's `modes` block, which §12.3 row 11 needs to build the mode select.
 *
 * Transcribed from `01-plain-answer.jsonl`'s `session/new` result, trimmed to the two fields the
 * row reads plus the description it carries through.
 */
export function claudeAcpModes(): Record<string, unknown> {
  return {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Manual", description: "Always ask before making changes" },
      { id: "acceptEdits", name: "Accept edits", description: "Automatically accept all file edits" },
      { id: "plan", name: "Plan", description: "Create a plan before making changes" },
    ],
  };
}

/** A deterministic id generator, so a synthesized id is a fixed string in an assertion. */
export function countingIds(): { synth(prefix: string): string } {
  let last: string | null = null;
  let n = 0;
  return {
    synth(prefix: string): string {
      if (prefix !== last) {
        last = prefix;
        n += 1;
      }
      return `omni:test:${prefix}:${String(n)}`;
    },
  };
}
