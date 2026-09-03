/**
 * A TYPE fixture, not a test: it is never executed. `id-types.test.ts` type-checks this file
 * with the TypeScript compiler API and asserts ZERO diagnostics — which is only true if every
 * `@ts-expect-error` below is actually an error. If template-literal ids ever stopped
 * discriminating, each directive would become an "unused '@ts-expect-error'" diagnostic and the
 * test would fail (D12, WP-1 acceptance 4).
 *
 * It imports the BUILT declarations, so what is proven is what consumers get.
 */
import type { DaemonId, TurnId, WorkerId, WorkerRef } from "../../dist/index.js";

declare const daemonId: DaemonId;
declare const workerId: WorkerId;
declare const turnId: TurnId;

declare function takesWorker(w: WorkerId): void;
declare function takesTurn(t: TurnId): void;
declare function takesRef(r: WorkerRef): void;

// The point of the whole exercise: three ids, three types, no brand ceremony.
// @ts-expect-error a DaemonId is not a WorkerId
takesWorker(daemonId);
// @ts-expect-error a TurnId is not a WorkerId
takesWorker(turnId);
// @ts-expect-error a WorkerId is not a TurnId
takesTurn(workerId);
// @ts-expect-error a bare string is not a WorkerId
takesWorker("w_00000000000000000000000001" as string);
// @ts-expect-error the prefixes do not compose in the wrong order
takesRef(`${workerId}:${daemonId}`);

const _assignments: [DaemonId, WorkerId, TurnId, WorkerRef] = [
  daemonId,
  workerId,
  turnId,
  `${daemonId}:${workerId}`,
];

// A literal of the right shape IS assignable — that is what makes the type ergonomic.
takesWorker("w_00000000000000000000000001");
takesTurn("t_00000000000000000000000001");

export type { _assignments };
