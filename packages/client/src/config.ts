import { OmniError } from "@omni-acp/protocol";
import type { ConfigOptionView, SetConfigResponse, WorkerId } from "@omni-acp/protocol";
import type { Transport } from "./transport.js";

/**
 * `worker.config` / `worker.setConfig()` (H24).
 *
 * The list is updated SYNCHRONOUSLY with the promise's resolution — no round trip, no waiting for
 * a notification — because neither real agent emits a `config_option_update` for a set (F34,
 * F35), so a channel that waited for one would wait forever. A `503` or a network failure leaves
 * the cached list UNCHANGED rather than clearing it: a failed write did not change the agent's
 * catalogue.
 *
 * Membership can SHRINK (F34's four → two), so a caller must re-read the list and never cache one
 * entry — which is why `config` is a getter over the whole list rather than a lookup.
 *
 * Owned by M2-A-WP-C.
 */
export interface ConfigChannel {
  readonly options: readonly ConfigOptionView[] | null;
  set(configId: string, value: string | number | boolean): Promise<readonly ConfigOptionView[]>;
}

export function createConfigChannel(
  transport: Transport,
  id: WorkerId,
  seed: () => readonly ConfigOptionView[] | null,
): ConfigChannel {
  /**
   * The last list a SET returned, or `null` while this channel has set nothing.
   *
   * `null` and not `seed()` at construction: the handle is built before its first snapshot
   * refresh, and a value copied once here would freeze at whatever the create response happened
   * to carry. Reading through `seed` until the first set is what keeps `worker.config` equal to
   * `worker.snapshot.configOptions` for a caller that never sets anything.
   */
  let current: readonly ConfigOptionView[] | null = null;

  return {
    get options(): readonly ConfigOptionView[] | null {
      return current ?? seed();
    },

    async set(
      configId: string,
      value: string | number | boolean,
    ): Promise<readonly ConfigOptionView[]> {
      // ONE round trip. The assignment below is the ONLY place `current` moves, and it happens
      // after the await — so a `503`, a `409 worker_busy`, a `423` or a dropped socket all leave
      // the cached list exactly as it was. A half-updated snapshot is worse than a stale one
      // (§22.2's SDK row).
      const response = await transport.request<SetConfigResponse>(
        "POST",
        `/v1/workers/${id}/config`,
        { configId, value },
      );
      const options = response?.configOptions;
      if (!Array.isArray(options)) {
        // The daemon answered `200` with a body this SDK cannot read. Refusing here — rather
        // than caching `undefined` and reporting it as the agent's catalogue — is the same rule
        // the assignment order enforces: the cached list only ever moves to a list we have.
        throw new OmniError("internal", "the daemon returned no configOptions", {
          detail: { workerId: id, configId },
        });
      }
      // SYNCHRONOUS with the resolution: the caller's next read of `worker.config` sees this
      // list, with no event-stream round trip in between. `stale: true` carries the daemon's
      // KEPT previous list, so assigning it is still assigning the truth rather than a guess.
      current = options;
      return current;
    },
  };
}
