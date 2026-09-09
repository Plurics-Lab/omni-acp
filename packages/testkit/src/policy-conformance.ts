import { describe, expect, it } from "vitest";
import {
  AcpRequestError,
  type EventInput,
  type InteractionContext,
  type InteractionId,
  type InteractionStrategy,
  type MappedPermissionRequest,
  type PermissionOption,
  type PolicyDecisionPayload,
  type RequestPermissionResponse,
} from "@omni-acp/protocol";

export interface PolicyFixtureOptions {
  readonly offered: readonly PermissionOption[];
  readonly kind: string | null;
  readonly paths: readonly string[];
}

/**
 * D4's six hard rules, over a GENERATED `offered` array — a fixed 64-row table plus a seeded
 * shuffle, and no new dependency for either (Land exit criterion 7).
 *
 * Three degenerate arrays carry most of the value and are each a recorded failure rather than an
 * invented edge case: the EMPTY array; the unknown-kind-only array (D4 rule 6 — an agent that
 * invents a kind must not be able to land on a grant); and the `allow_always`-ONLY array, whose
 * correct answer is `-32603` and whose wrong answer is F26 — after one `allow_always` the engine
 * is never consulted again for that session and nothing on the wire says so.
 *
 * It runs against the ENGINE and still against `baselineInteractions`, so M2-B cannot narrow D4
 * by editing one of them.
 *
 * ── WHICH RULES THIS SUITE ASSERTS, AND WHY NOT ALL SIX ─────────────────────────────────────
 *
 * Rules 1, 3, 4, 5 and 6 are INVARIANTS: no policy, no rule set and no ordering may break them,
 * so they can be asserted against a strategy whose decisions this suite deliberately does not
 * know. Rule 2 is an ORDERING PREFERENCE between two acceptable grants — an operator may
 * legitimately turn its session-grant half off — so it is asserted where the preference lives,
 * in `permission-responder.test.ts`, and not here where it would forbid a legal policy.
 *
 * Owned by M2-B-WP-P.
 */

/**
 * SIX candidate options, so the fixed table is EXACTLY the 64 subsets of them — the empty array,
 * the `allow_always`-only array and the unknown-kind-only array are rows of that one enumeration
 * rather than three hand-written extras that could drift from it.
 *
 * The `name`s are deliberately misleading (one of them embeds a path, exactly as F27's recording
 * did): a strategy that read a label instead of a `kind` should fail here.
 */
const UNKNOWN_KIND = "a_kind_nobody_models";

const CANDIDATES = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
  { optionId: "always", name: "Yes, and don't ask again for src/main.ts", kind: "allow_always" },
  { optionId: "never", name: "Allow", kind: "reject_always" },
  { optionId: "allow_session", name: "Allow for this session", kind: "allow_once" },
  { optionId: "weird", name: "Just do it", kind: UNKNOWN_KIND },
] as unknown as readonly PermissionOption[];

/** The 64 rows: subset `n` holds candidate `i` iff bit `i` of `n` is set. Deterministic, total. */
function fixedTable(): readonly (readonly PermissionOption[])[] {
  const rows: PermissionOption[][] = [];
  for (let mask = 0; mask < 1 << CANDIDATES.length; mask++) {
    const row: PermissionOption[] = [];
    for (let i = 0; i < CANDIDATES.length; i++) {
      if ((mask & (1 << i)) !== 0) row.push(CANDIDATES[i] as PermissionOption);
    }
    rows.push(row);
  }
  return rows;
}

/** A 32-bit LCG. Seeded, reproducible, and NOT a new dependency (Land exit criterion 7). */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffled<T>(items: readonly T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const held = out[i] as T;
    out[i] = out[j] as T;
    out[j] = held;
  }
  return out;
}

/** The two kinds that may ever be selected. Everything else is a non-grant (D4 rules 3 and 6). */
const SELECTABLE_KINDS: ReadonlySet<string> = new Set(["allow_once", "reject_once"]);

/** Rows whose ONLY correct answer is `-32603`: nothing on the menu may ever be selected. */
const nothingAcceptable = (offered: readonly PermissionOption[]): boolean =>
  !offered.some((o) => SELECTABLE_KINDS.has(o.kind));

function requestFor(
  offered: readonly PermissionOption[],
  o: PolicyFixtureOptions,
): MappedPermissionRequest {
  return {
    sessionId: "sess_conformance",
    title: "Write src/main.ts",
    subject: {
      type: "tool_call",
      toolCall: {
        toolCallId: "call_conformance",
        title: "Write src/main.ts",
        ...(o.kind === null ? {} : { kind: o.kind }),
        locations: o.paths.map((path) => ({ path })),
      },
    },
    options: [...offered],
    toolCallId: "call_conformance",
    raw: { sessionId: "sess_conformance", options: [...offered] },
  };
}

interface Observation {
  readonly response: RequestPermissionResponse | null;
  readonly error: unknown;
  readonly emitted: readonly EventInput[];
}

async function observe(
  strategy: InteractionStrategy,
  req: MappedPermissionRequest,
): Promise<Observation> {
  const emitted: EventInput[] = [];
  const ctx: InteractionContext = {
    turnId: null,
    emit(inputs) {
      emitted.push(...inputs);
    },
    park(_id: InteractionId) {
      // Every row here is auto-resolved: a parked one is WP-I's lifecycle, not D4's rule set.
      return () => undefined;
    },
    failTurn() {
      throw new Error("policy conformance: a permission decision must never fail the turn");
    },
  };
  try {
    return { response: await strategy.permission(req, ctx), error: null, emitted };
  } catch (error) {
    return { response: null, error, emitted };
  }
}

/** Every `omni.policy_decision` the strategy wrote for this request. */
function decisionsOf(emitted: readonly EventInput[]): readonly PolicyDecisionPayload[] {
  return emitted
    .filter((e) => e.kind === "omni.policy_decision")
    .map((e) => e.payload as PolicyDecisionPayload);
}

export function runPolicyConformance(
  name: string,
  make: (o: PolicyFixtureOptions) => InteractionStrategy,
): void {
  const table = fixedTable();
  // One seed, spelled out, so a failing row is reproducible from the file alone.
  const rows: readonly { readonly label: string; readonly offered: readonly PermissionOption[] }[] =
    (() => {
      const rnd = lcg(0x5eed_c0de);
      return [
        ...table.map((offered, i) => ({ label: `subset ${String(i)}`, offered })),
        ...table.map((offered, i) => ({
          label: `subset ${String(i)} shuffled`,
          offered: shuffled(offered, rnd),
        })),
      ];
    })();

  /** Three subjects, so a strategy cannot pass by branching on one shape. */
  const SUBJECTS: readonly Pick<PolicyFixtureOptions, "kind" | "paths">[] = [
    { kind: "edit", paths: ["/repo/src/main.ts"] },
    { kind: null, paths: [] },
    { kind: "a_tool_kind_nobody_has_seen", paths: ["/etc/passwd", "/repo/src/main.ts"] },
  ];

  const each = async (
    check: (o: {
      readonly label: string;
      readonly offered: readonly PermissionOption[];
      readonly observation: Observation;
    }) => void,
  ): Promise<void> => {
    for (const row of rows) {
      for (const subject of SUBJECTS) {
        const options: PolicyFixtureOptions = { offered: row.offered, ...subject };
        const strategy = make(options);
        try {
          const observation = await observe(strategy, requestFor(row.offered, options));
          check({
            label: `${row.label} / kind=${String(subject.kind)}`,
            offered: row.offered,
            observation,
          });
        } finally {
          strategy.close();
        }
      }
    }
  };

  describe(`D4 conformance: ${name}`, () => {
    it("the fixed table is 64 rows and contains all three degenerate arrays by construction", () => {
      expect(table.length).toBe(64);
      expect(table.filter((row) => row.length === 0).length, "the EMPTY array").toBe(1);
      expect(
        table.filter((row) => row.length === 1 && row[0]?.kind === "allow_always").length,
        "the allow_always-only array",
      ).toBe(1);
      expect(
        table.filter((row) => row.length === 1 && String(row[0]?.kind) === UNKNOWN_KIND).length,
        "the unknown-kind-only array",
      ).toBe(1);
      expect(rows.length, "table plus its seeded shuffle").toBe(128);
    });

    it("rule 1: every answer names an optionId the agent actually offered", async () => {
      await each(({ label, offered, observation }) => {
        const response = observation.response;
        if (response === null) return;
        const picked = (response.outcome as { optionId?: unknown }).optionId;
        expect(typeof picked, `${label}: answered without an id`).toBe("string");
        expect(
          offered.map((o) => o.optionId),
          `${label}: answered with an id nobody offered`,
        ).toContain(picked);
      });
    });

    it("rule 3: an allow_always option is never selected, by any path", async () => {
      await each(({ label, offered, observation }) => {
        const response = observation.response;
        if (response === null) return;
        const picked = (response.outcome as { optionId?: unknown }).optionId;
        const chosen = offered.find((o) => o.optionId === picked);
        expect(chosen?.kind, `${label}: selected a persistent grant`).not.toBe("allow_always");
      });
    });

    it("rule 4: nothing acceptable offered means -32603, and NEVER anything else", async () => {
      await each(({ label, offered, observation }) => {
        if (!nothingAcceptable(offered)) return;
        expect(
          observation.response,
          `${label}: answered a menu with nothing selectable`,
        ).toBeNull();
        expect(observation.error, `${label}: rejected with a non-ACP error`).toBeInstanceOf(
          AcpRequestError,
        );
        expect((observation.error as AcpRequestError).code, `${label}: wrong JSON-RPC code`).toBe(
          -32603,
        );
      });
    });

    it("rule 5: the answer is never outcome:'cancelled' — not even when it cannot answer", async () => {
      await each(({ label, observation }) => {
        const response = observation.response;
        if (response === null) return;
        expect(response.outcome.outcome, `${label}: cancelled the whole turn`).toBe("selected");
      });
    });

    it("rule 6: an unknown kind is a non-grant, and never shadows a real one", async () => {
      const unknownOnly = table.find(
        (row) => row.length === 1 && String(row[0]?.kind) === UNKNOWN_KIND,
      );
      expect(unknownOnly).toBeDefined();

      await each(({ label, offered, observation }) => {
        const response = observation.response;
        if (response === null) return;
        const picked = (response.outcome as { optionId?: unknown }).optionId;
        const chosen = offered.find((o) => o.optionId === picked);
        expect(chosen, `${label}: answered with an id that is not on the menu`).toBeDefined();
        expect(
          SELECTABLE_KINDS.has((chosen as PermissionOption).kind),
          `${label}: selected an option whose kind is not a known grant`,
        ).toBe(true);
      });
    });

    it("never rejects with anything but an AcpRequestError — a rejection is an agent that hangs", async () => {
      await each(({ label, observation }) => {
        if (observation.error === null) return;
        expect(observation.error, `${label}`).toBeInstanceOf(AcpRequestError);
      });
    });

    it("the recorded decision agrees with the answer: id offered, and null iff it errored", async () => {
      await each(({ label, offered, observation }) => {
        for (const decision of decisionsOf(observation.emitted)) {
          if (decision.optionId !== null) {
            expect(
              offered.map((o) => o.optionId),
              `${label}: recorded an id nobody offered`,
            ).toContain(decision.optionId);
            expect(decision.decision, `${label}: recorded an error with an id`).not.toBe("error");
          } else {
            expect(
              observation.response,
              `${label}: recorded no id but still answered the agent`,
            ).toBeNull();
          }
        }
      });
    });
  });
}
