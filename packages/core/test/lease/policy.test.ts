import { describe, expect, it } from "vitest";
import { LeaseConfig, type ClientRef, type LeaseSnapshot, type TokenId } from "@omni-acp/protocol";
import { isStaleEpoch, mayAct, maySteal, sameClient, toWire } from "../../src/lease/policy.js";

/**
 * §16.1's rules L3-L8 as a TABLE, with no clock, no worker and no HTTP — which is the reason
 * `policy.ts` exists at all. `lease.ts` composes these; the conformance suite proves the
 * composition; this file proves the rules.
 */

const WID = "w_00000000000000000000000001" as const;
const A: ClientRef = { tokenId: "tok_a" as TokenId, clientId: "cli_a" };
const A2: ClientRef = { tokenId: "tok_a" as TokenId, clientId: "cli_b" };
const A_ANON: ClientRef = { tokenId: "tok_a" as TokenId, clientId: null };
const C: ClientRef = { tokenId: "tok_c" as TokenId, clientId: "cli_c" };

const CONFIG = LeaseConfig.parse({});

const snapshotOf = (holder: ClientRef | null, epoch: number): LeaseSnapshot => ({
  workerId: WID,
  holder: holder === null ? null : toWire(holder),
  epoch,
  expiresAt: null,
  acquiredAt: null,
  pinned: false,
});

describe("sameClient — rule L4's identity, decided in one place", () => {
  const cases: [string, ClientRef, ClientRef, boolean][] = [
    ["same token, same client id", A, { ...A }, true],
    ["same token, different client id", A, A2, false],
    ["different token, same client id", A, { ...A, tokenId: "tok_z" as TokenId }, false],
    // L4: `clientId: null` is "the token's default client" and is SHARED, because a daemon
    // genuinely cannot tell two header-less clients of one token apart. Saying so is honest;
    // pretending otherwise would hand two curl users one controller each.
    ["two header-less clients of one token are ONE controller", A_ANON, { ...A_ANON }, true],
    ["a header-less client is not the same as a named one", A_ANON, A, false],
  ];
  for (const [name, a, b, expected] of cases) {
    it(name, () => {
      expect(sameClient(a, b)).toBe(expected);
      expect(sameClient(b, a)).toBe(expected);
    });
  }

  it("ignores the fencing epoch — a fence is a claim, not an identity", () => {
    expect(sameClient({ ...A, epoch: 9 }, A)).toBe(true);
  });
});

describe("isStaleEpoch — rule L7", () => {
  const lease = snapshotOf(A, 4);
  it("ABSENT means no check: `Omni-Lease-Epoch` is optional", () => {
    expect(isStaleEpoch(lease, undefined)).toBe(false);
  });
  it("equal is fresh", () => {
    expect(isStaleEpoch(lease, 4)).toBe(false);
  });
  it("behind is stale", () => {
    expect(isStaleEpoch(lease, 3)).toBe(true);
  });
  it("ahead is stale too — it names a state this lease has never been in", () => {
    expect(isStaleEpoch(lease, 5)).toBe(true);
  });
  it("0 is a real epoch, not 'absent'", () => {
    expect(isStaleEpoch(snapshotOf(null, 0), 0)).toBe(false);
    expect(isStaleEpoch(lease, 0)).toBe(true);
  });
});

describe("mayAct — who may run a gated verb", () => {
  const table: [string, LeaseSnapshot, ClientRef, { admin: boolean; epoch?: number }, boolean][] = [
    ["L5: an unheld lease grants the first caller", snapshotOf(null, 0), A, { admin: false }, true],
    ["the holder acts", snapshotOf(A, 1), A, { admin: false }, true],
    ["a same-token peer does not", snapshotOf(A, 1), A2, { admin: false }, false],
    ["another token does not", snapshotOf(A, 1), C, { admin: false }, false],
    // L3's other half: `registry.delete()` is the only caller that passes `admin: true`, because
    // it is the only one holding an `AuthContext`. The lease itself always passes false.
    ["L3: admin acts without the lease", snapshotOf(A, 1), C, { admin: true }, true],
    ["L7: a stale fence beats the holder", snapshotOf(A, 1), A, { admin: false, epoch: 0 }, false],
    // The ordering that matters: the fence is checked BEFORE the admin bypass, because an admin
    // acting on a world that has moved hijacks a turn exactly as loudly as anyone else.
    ["L7 beats L3 too", snapshotOf(A, 2), C, { admin: true, epoch: 1 }, false],
    ["a fresh fence passes", snapshotOf(A, 2), A, { admin: false, epoch: 2 }, true],
    [
      "a stale fence on an UNHELD lease still refuses",
      snapshotOf(null, 3),
      A,
      { admin: false, epoch: 2 },
      false,
    ],
  ];
  for (const [name, lease, who, o, expected] of table) {
    it(name, () => {
      expect(mayAct(lease, who, o)).toBe(expected);
    });
  }
});

describe("maySteal — rule L8 and D13", () => {
  const idle = (ms: number) => ({ nowMs: 10_000 + ms, lastUseMs: 10_000, config: CONFIG });

  it("D13: an admin steals from anybody, at any idle time", () => {
    const patient = LeaseConfig.parse({ stealAfterIdleMs: 3_600_000 });
    expect(
      maySteal(snapshotOf(A, 1), C, { admin: true, nowMs: 1, lastUseMs: 0, config: patient }),
    ).toBe(true);
  });

  it("an unheld lease and a self-steal are both just takes", () => {
    expect(maySteal(snapshotOf(null, 0), C, { admin: false, ...idle(0) })).toBe(true);
    expect(maySteal(snapshotOf(A, 1), A, { admin: false, ...idle(0) })).toBe(true);
  });

  it("D13: another TOKEN never steals without admin, however idle the holder is", () => {
    expect(maySteal(snapshotOf(A, 1), C, { admin: false, ...idle(86_400_000) })).toBe(false);
  });

  it("L8: a same-token peer waits stealAfterIdleMs, and the default 0 is 'immediately'", () => {
    expect(CONFIG.stealAfterIdleMs).toBe(0);
    expect(maySteal(snapshotOf(A, 1), A2, { admin: false, ...idle(0) })).toBe(true);

    const config = LeaseConfig.parse({ stealAfterIdleMs: 60_000 });
    const at = (ms: number) => ({ nowMs: 10_000 + ms, lastUseMs: 10_000, config });
    expect(maySteal(snapshotOf(A, 1), A2, { admin: false, ...at(59_999) })).toBe(false);
    expect(maySteal(snapshotOf(A, 1), A2, { admin: false, ...at(60_000) })).toBe(true);
    expect(maySteal(snapshotOf(A, 1), A2, { admin: false, ...at(60_001) })).toBe(true);
  });

  it("carries NO fencing check — a stealer's premise is that its epoch is old", () => {
    // If `maySteal` fenced, the client the verb exists for — the one that has been locked out
    // long enough for its cached epoch to rot — would be the one client that could never use it.
    expect(maySteal(snapshotOf(A, 99), { ...A2, epoch: 1 }, { admin: false, ...idle(0) })).toBe(
      true,
    );
  });
});
