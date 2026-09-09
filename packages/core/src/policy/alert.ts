/**
 * §20.6's fold, re-exported.
 *
 * It USED to be implemented here, and review finding V9 is why it is not any more: it had unit
 * tests and zero production callers, because the one caller that can produce its warning without
 * breaking D7 is `reduceTurn` — the same fold the SDK runs locally and `GET /turns/{id}` runs
 * server-side — and `@omni-acp/protocol` may not import `@omni-acp/core`. So the implementation
 * moved down a layer, `worker.ts` stamps the resolved `alertOnUnpoliced` on
 * `state_update{idle}._meta["omni/policy"]`, and this file keeps the name `@omni-acp/core`
 * exports so nothing that already imported it has to move.
 *
 * Owned by M2-B-WP-P.
 */
export { unpolicedToolCalls } from "@omni-acp/protocol";
