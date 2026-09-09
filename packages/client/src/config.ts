import { OmniError } from "@omni-acp/protocol";
import type { ConfigOptionView, WorkerId } from "@omni-acp/protocol";
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
  _transport: Transport,
  _id: WorkerId,
  _seed: () => readonly ConfigOptionView[] | null,
): ConfigChannel {
  throw new OmniError("internal", "unimplemented: M2-A-WP-C");
}
