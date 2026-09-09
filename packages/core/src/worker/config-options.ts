import type { ConfigOptionView, RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The agent's `configOptions` array → an addressable view, with `raw` kept BY IDENTITY (§7.5).
 *
 * The argument is the WHOLE result body (`{configOptions: [...]}`) rather than the array, because
 * `null` and `[]` are different answers: `null` means the method returned no list at all, which
 * is `SetConfigResponse.stale: true` and "keep the previous list", while `[]` means the agent
 * really does offer nothing now. Merging a guess would resurrect the two entries F34's four→two
 * shrink dropped.
 *
 * The entry's own key is `id` — MEASURED on both agents, not assumed: claude-acp transcript `15`
 * and codex-acp transcript `07` both spell it `id`. `configId` is the REQUEST parameter and lives
 * in `Quirks.configIdField` (F34); review R3 records that there is only that one quirk and that a
 * second one for the entry key would have described a variable nobody has ever observed varying.
 *
 * F35 is why identity matters here and not merely as a principle: codex spells its model id two
 * ways — `models.availableModels[].modelId: "gpt-5.6-sol[low]"` against
 * `configOptions[model].currentValue: "gpt-5.6-sol"` — so anything that normalized `currentValue`
 * would make a snapshot fail to match itself.
 *
 * PURE and TOTAL: a body it cannot read is `null`, never a throw.
 *
 * `_d` IS THE DESCRIPTOR AND IT IS DELIBERATELY UNREAD. §22.1 trap 3 settles it: the entry key
 * was measured on both corpora rather than assumed, so there is no `configOptionIdField` to
 * branch on, and a descriptor field with one possible value is a branch an implementer has to
 * keep in sync for nothing. The parameter stays because §5.8.9 declares it and `Worker.setConfig`
 * (frozen, M2-PLAN §1.2 hunk 6) passes it; the day a transcript shows an agent spelling the entry
 * differently is the day the quirk is added, with that transcript. `config-options.test.ts` pins
 * the ruling by asserting that two descriptors disagreeing about `quirks.configIdField` produce
 * DEEP-EQUAL views of the same body.
 *
 * Owned by M2-A-WP-C.
 */
export function viewConfigOptions(
  result: unknown,
  _d: RuntimeDescriptor,
): readonly ConfigOptionView[] | null {
  const body = record(result);
  if (body === null) return null;
  const entries = body["configOptions"];
  // NOT an array ⇒ the body carried no list at all, which is `stale: true` upstream. `null` is
  // the honest answer for an absent key, a `null` key and a scalar alike: none of them is a
  // catalogue, and none of them justifies discarding the one we hold.
  if (!Array.isArray(entries)) return null;

  const out: ConfigOptionView[] = [];
  for (const entry of entries) {
    const o = record(entry);
    if (o === null) continue;
    const id = o["id"];
    // An entry with no `id` is not ADDRESSABLE: `POST …/config` takes one `configId`, and an
    // entry nobody can name is one nobody can set. It is dropped rather than failing the whole
    // body, because failing it would answer `null` — "keep the previous list" — and that is how
    // a phantom entry survives a shrink (F34). One unreadable row must not resurrect four.
    if (typeof id !== "string" || id === "") continue;
    out.push({
      id,
      // Verbatim, `undefined` included: `currentValue` is the agent's word for what is in force
      // and F35's two model spellings are only distinguishable while nobody normalizes it.
      currentValue: o["currentValue"],
      // BY IDENTITY — the very object the agent sent, not a copy (§7.5). `Worker.setConfig` feeds
      // `raw` straight back into the synthesized `config_option_update`, so a rebuild here would
      // put a shape we invented on the wire under the agent's name.
      raw: o,
    });
  }
  return out;
}

/**
 * The membership delta between two catalogues, for `SetConfigResponse.{removed, added}`.
 *
 * PURE, and it is the ONLY thing `POST …/config` says about the shrink: F34's `model → haiku`
 * dropped `effort` because Haiku exposes no effort levels, and a client that re-rendered a
 * control for it would be rendering one the agent will now refuse. Order is the catalogue's, so
 * two calls with the same lists produce deep-equal responses.
 *
 * `null` on either side is the EMPTY set and never a third answer: "we held no catalogue" makes
 * every entry of the new one `added`, which is exactly what a caller has to render, and the one
 * question that would be misleading — "the method returned nothing, so what changed?" — is never
 * asked, because `Worker.setConfig` passes the PREVIOUS list on both sides when `stale` is true.
 *
 * The wire call itself is NOT here: review R12 moved it into `Worker.setConfig` (M2-PLAN §1.2
 * hunk 6), which is the only place that holds the lease gate, the `worker_busy` gate, the
 * auto-wake and the previous list — leaving this file the pure half that M2-A-WP-C unit-tests
 * against transcripts `15` and `07` with no link at all.
 *
 * Owned by M2-A-WP-C.
 */
export function configOptionsDelta(
  previous: readonly ConfigOptionView[] | null,
  next: readonly ConfigOptionView[] | null,
): { readonly removed: readonly string[]; readonly added: readonly string[] } {
  const before = idsOf(previous);
  const after = idsOf(next);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    removed: before.filter((id) => !afterSet.has(id)),
    added: after.filter((id) => !beforeSet.has(id)),
  };
}

/** The catalogue's ids, in the catalogue's order, each named once. */
function idsOf(options: readonly ConfigOptionView[] | null): readonly string[] {
  if (options === null) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const option of options) {
    if (seen.has(option.id)) continue;
    seen.add(option.id);
    out.push(option.id);
  }
  return out;
}

/** An object that is not an array — the only shape either helper can read a field out of. */
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
