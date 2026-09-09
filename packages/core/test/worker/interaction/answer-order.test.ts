import { describe, expect, it } from "vitest";
import { OmniError } from "@omni-acp/protocol";
import type { ClientRef, InteractionId, Lease, LeaseSnapshot } from "@omni-acp/protocol";
import { OWNER, TEXT, WORKER_ID } from "../support/harness.js";
import { flush, MENU, rig, type Rig } from "./support/rig.js";

/**
 * §19.6's check ORDER for `POST /v1/workers/{wid}/interactions/{reqId}`, as a table.
 *
 *     visibility → worker state → interaction existence → lease → body SHAPE → semantics
 *
 * Review finding V10: the shipped order was the INVERSE of the middle of that table. The route
 * parsed `InteractionAnswerBody` first, the registry parsed it again, and `Worker.answerInteraction`
 * called `lease.assertHolder` before it had looked anything up — so a non-holder answering a stale
 * request id got `423 lease_held` ("a stale request id does not report a lease problem it does not
 * have" is the sentence §19.6 spends on exactly this), a malformed body from a non-holder got
 * `400`, and the table's `410 worker_closed` row was unreachable because nothing consulted the
 * state at all.
 *
 * Every row below is driven through ONE assembled worker, its real strategy and a real lease that
 * actually refuses — the two halves the previous tests each had only one of: `http/interactions
 * .test.ts` mapped pre-thrown `OmniError`s to statuses and never exercised an order, and the rig's
 * default lease grants everything.
 *
 * Owned by M2-B (review round 2).
 */

/** Another client of the same token: visible, allowed to READ, and not the holder (rule L2/L5). */
const OBSERVER: ClientRef = { tokenId: OWNER.tokenId, clientId: "cli_observer" as never };
const WHO = { ...OWNER, tokenId: OWNER.tokenId };
const NOT_HOLDER = { ...OBSERVER, tokenId: OWNER.tokenId };

const STALE = "x_00000000000000000000000009" as InteractionId;

/** A lease held by OWNER that REFUSES anybody else — M1-WP-D's behaviour, in miniature. */
function strictLease(): Lease {
  const snapshot = (): LeaseSnapshot => ({
    workerId: WORKER_ID,
    holder: { tokenId: OWNER.tokenId, clientId: OWNER.clientId },
    epoch: 1,
    expiresAt: null,
    acquiredAt: null,
    pinned: false,
  });
  return {
    get holder() {
      return { tokenId: OWNER.tokenId, clientId: OWNER.clientId };
    },
    epoch: 1,
    snapshot,
    assertHolder(who: ClientRef): LeaseSnapshot {
      if (who.clientId !== OWNER.clientId) {
        throw new OmniError("lease_held", `worker ${WORKER_ID} is held by another client`);
      }
      return snapshot();
    },
    acquire: () => snapshot(),
    release: () => snapshot(),
    steal: () => snapshot(),
    pinExpiry: () => () => {},
    releaseForHibernate: () => snapshot(),
    onChange: () => () => {},
    close: () => {},
  } as unknown as Lease;
}

/** A worker with ONE parked interaction and a lease only OWNER holds. */
async function parked(): Promise<{ r: Rig; id: InteractionId }> {
  const r = await rig({ onUnresolved: "park", lease: strictLease() });
  await r.worker.prompt([TEXT("please edit")], OWNER);
  await flush();
  void r.agent.requestPermission("p1", {
    sessionId: "sess_recording",
    toolCall: { toolCallId: "call_1", title: "Write hello.txt", kind: "edit" },
    options: [...MENU],
  });
  await flush();
  const first = r.worker.interactions[0];
  if (first === undefined) throw new Error("nothing parked");
  return { r, id: first.requestId };
}

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
    return "no-throw";
  } catch (e) {
    return e instanceof OmniError ? e.code : `not-an-OmniError: ${String(e)}`;
  }
};

describe("§19.6 — the check order for answering an interaction (review finding V10)", () => {
  it("a NON-HOLDER with a stale request id is `interaction_not_found`, not `lease_held`", async () => {
    const { r } = await parked();
    // Existence precedes the lease, and it leaks nothing: the pending set is already public
    // through the UNGATED `GET …/interactions` (rule L2).
    expect(codeOf(() => r.worker.answerInteraction(STALE, { action: "deny" }, NOT_HOLDER))).toBe(
      "interaction_not_found",
    );
  });

  it("a NON-HOLDER with a MALFORMED body is `lease_held`, not `bad_request`", async () => {
    const { r, id } = await parked();
    // The shape is checked after the lease, so the caller is told the thing that stops them
    // first. This is the row the ROUTE used to decide, by parsing before the daemon was called.
    expect(codeOf(() => r.worker.answerInteraction(id, { action: "shrug" }, NOT_HOLDER))).toBe(
      "lease_held",
    );
  });

  it("the HOLDER with a stale request id is `interaction_not_found` — the control", async () => {
    const { r } = await parked();
    expect(codeOf(() => r.worker.answerInteraction(STALE, { action: "deny" }, WHO))).toBe(
      "interaction_not_found",
    );
  });

  it("the HOLDER with a malformed body is `bad_request`, naming the field", async () => {
    const { r, id } = await parked();
    let thrown: unknown;
    try {
      r.worker.answerInteraction(id, { action: "shrug" }, WHO);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OmniError);
    expect((thrown as OmniError).code).toBe("bad_request");
    expect((thrown as OmniError).message).toContain("invalid interaction answer");
  });

  it("answering on a CLOSED worker is `worker_closed` — the table's 410 row, now reachable", async () => {
    const { r, id } = await parked();
    await r.worker.close("client_request");
    // Before this, nothing on this path consulted the state, so a closed worker answered
    // `interaction_not_found` and §19.6's 410 row could not be produced at all.
    expect(codeOf(() => r.worker.answerInteraction(id, { action: "deny" }, WHO))).toBe(
      "worker_closed",
    );
  });

  it("a well-formed answer from the HOLDER still settles it", async () => {
    const { r, id } = await parked();
    const result = r.worker.answerInteraction(id, { action: "deny" }, WHO);
    expect(result.interaction.status).toBe("answered");
    expect(result.interaction.settledBy).toBe("human");
  });
});
