import type { RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * A fully-defaulted `RuntimeDescriptor` for tests that need one and do not care which
 * (CONTRACTS.md §5.7).
 *
 * It is REAL rather than a throwing stub because it is a fixture, and a fixture that throws is
 * not a fixture. It restates the zero-quirk table rather than importing `DEFAULT_V1_PROFILE`
 * from `@omni-acp/core`: the §3.1 DAG is `protocol -> testkit` and `protocol -> core -> daemon`,
 * and a `testkit -> core` edge would close the cycle that `contracts.ts` exists to prevent.
 *
 * Everything it asserts is the ABSENCE of a quirk — the only thing a test may claim about an
 * agent it has not probed.
 */
export function fakeRuntime(overrides?: Partial<RuntimeDescriptor>): RuntimeDescriptor {
  const base: RuntimeDescriptor = {
    id: "fake",
    fingerprint: "fake000000000000",
    protocolVersion: 1,
    source: "builtin",
    prefer: {
      resume: ["session/resume", "session/load"],
      setConfig: [],
      list: [],
      close: ["session/close"],
    },
    updates: {},
    extensions: {},
    errorRules: [],
    quirks: {
      resumeSilentlyCreates: false,
      resumeRequiresSameCwd: false,
      loadReturnsBody: false,
      messageIdPresent: false,
      toolCallUpdateIsSparse: false,
      diffIsFragment: false,
      permissionRequestShape: "v1_tool_call",
      sessionGrantKind: "none",
      emitsUsageUpdateOnV1: false,
      emitsStateUpdate: false,
      configIdField: "configId",
      toleratesOmittedMcpCapabilities: false,
      unknownMethodErrorCode: -32601,
    },
    clientHost: { fs: false, terminal: false },
    budgets: { initializeMs: 60_000, sessionNewMs: 60_000, resumeMs: 90_000, turnMs: 600_000 },
    unverified: [],
  };
  return overrides === undefined ? base : { ...base, ...overrides };
}
