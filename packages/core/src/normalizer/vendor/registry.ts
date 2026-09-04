import type { MethodPreference, RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The vendor-extension registry (§17.3): which `_meta` pointers this runtime promotes into typed
 * slots, and which method spellings it has been PROVEN to answer.
 *
 * It learns from `-32601` per process and never from message text (F17). Registrations are keyed
 * by descriptor, so a compatible fork is a new descriptor rather than new code.
 *
 * Owned by M1-WP-E; consumed by M1-WP-B's map.
 */
export interface VendorRegistry {
  /**
   * The spellings to try, in order, minus everything this process has proven unsupported.
   *
   * `capability` is a plain `string` and not a closed union: `MethodPreferences` is a RECORD
   * (review R2) precisely so a runtime may carry a capability this milestone has not named, and
   * a consumer that does not know a key ignores it. The well-known keys are `resume` /
   * `setConfig` / `setOptions` / `list` / `close`, and an unknown one returns `[]` rather than
   * throwing — "this runtime cannot do that" is an answer, not a crash.
   */
  spellingsFor(capability: string): readonly string[];
  /** What a failure of this capability MEANS (DESIGN §6.2, made a field). Unknown ⇒ `"fail"`. */
  onFailureFor(capability: string): "fail" | "warn";
  /** Record a `-32601`. Process-local: never persisted, because a version bump may add it back. */
  noteUnsupported(method: string): void;
  readonly unsupported: ReadonlySet<string>;
  /** The descriptor this registry was keyed by — the ONLY thing any of it branches on. */
  readonly descriptor: RuntimeDescriptor;
}

export interface VendorRegistryOptions {
  /**
   * Methods a probe already found `-32601` (`ProbeSummary.unsupportedMethods`). §17.3: "the
   * probe's `unsupportedMethods` seeds the set at construction" — so the first real call skips a
   * spelling we have already paid a round trip to disprove, instead of re-learning it per worker.
   */
  readonly seedUnsupported?: readonly string[];
}

export function createVendorRegistry(
  descriptor: RuntimeDescriptor,
  o?: VendorRegistryOptions,
): VendorRegistry {
  /**
   * PER PROCESS, and never persisted (§17.3). A `-32601` is a fact about the adapter version
   * that answered it; writing it to disk would make an upgrade that ADDS the method invisible
   * until somebody cleared a cache, which is the failure mode the corpus's `set_model` row is a
   * standing warning about.
   */
  const unsupported = new Set<string>(o?.seedUnsupported ?? []);

  const preferenceFor = (capability: string): MethodPreference | undefined =>
    Object.hasOwn(descriptor.prefer, capability) ? descriptor.prefer[capability] : undefined;

  return {
    descriptor,
    unsupported,

    spellingsFor(capability): readonly string[] {
      const preference = preferenceFor(capability);
      if (preference === undefined) return [];
      // Order is the descriptor's (the probe already reordered it in `resolveDescriptor`); this
      // only subtracts what THIS process has disproved. Returning a fresh array keeps the
      // descriptor's own list immutable for every other caller.
      return preference.spellings.filter((spelling) => !unsupported.has(spelling));
    },

    onFailureFor(capability): "fail" | "warn" {
      // `fail` is the conservative default for a capability nobody declared: a caller that asked
      // for something and did not get it has not had its request honoured, and only a capability
      // the descriptor explicitly marks `warn` (a vendor extension we merely offered to pass
      // through) may downgrade that to a `TurnWarning`.
      return preferenceFor(capability)?.onFailure ?? "fail";
    },

    noteUnsupported(method): void {
      unsupported.add(method);
    },
  };
}
