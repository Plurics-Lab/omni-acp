import { describe, it } from "vitest";

/**
 * D5 over the wire: two SDK clients, ONE token, distinct client ids (M1-PLAN §2, WP-F 9).
 *
 * The pairing is the whole point — observer mode is what makes the lease worth having, so the
 * second client must stream the holder's entire turn while its own `prompt` is `423`.
 *
 * Owned by M1-WP-F.
 */
describe("lease contention between two SDK clients", () => {
  it.todo(
    "the observer streams the holder's WHOLE turn (omni.lease included) while its own prompt is 423 with the holder named",
  );
  it.todo("steal transfers the lease, bumps the epoch, and the first client's next call is 423");
  it.todo("a stale Omni-Lease-Epoch is 423 even from the right client id");
  it.todo("GET and the SSE stream are NEVER lease-gated");
});
