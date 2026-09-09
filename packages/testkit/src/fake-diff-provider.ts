import type { DiffProvider, PatchHandle, PatchResult, WorkerId } from "@omni-acp/protocol";

/**
 * A `DiffProvider` with no git and no process, so M2-A-WP-W can consume the INTERFACE without
 * ever touching M2-WP-J's implementation — which is what makes those two packages independent.
 *
 * It can be told to hang, to fail, and to return an over-size patch, because those are the three
 * shapes `TurnResult.patch` has to stay honest about: a hung provider still yields `idle` with
 * `patch: null` and a `patch_timeout` warning.
 *
 * Owned by M2-A-WP-W.
 */
export interface FakeDiffProviderOptions {
  /** The patch text `end` reports. `null` ⇒ D8's honest "no patch", with `quality:"unavailable"`. */
  readonly text?: string | null;
  /**
   * `end` never resolves and never rejects until its `AbortSignal` fires.
   *
   * This is the hang `worker.ts`'s `diff.timeoutMs` bound exists for: `end` runs immediately
   * before `prompt_result` is fed, so a provider that never returns means `idle` is never emitted
   * and `TurnResult` never settles (§25.1, review R14). A number is not taken, because a hang
   * measured in milliseconds against a fake clock is a race and this is not.
   */
  readonly hang?: boolean;
  /** `end` REJECTS. Contract-illegal ("NEVER throws") on purpose: the worker must survive it. */
  readonly fail?: boolean;
  /** `begin` answers `null` — "this cwd is not a repo", which is the D8 case that is not an error. */
  readonly outsideRepo?: boolean;
  /** `begin` REJECTS. Also contract-illegal on purpose (`worker.ts` logs and carries on). */
  readonly failBegin?: boolean;
  readonly truncated?: boolean;
  readonly quality?: PatchResult["quality"];
  readonly warnings?: PatchResult["warnings"];
}

export interface FakeDiffProvider extends DiffProvider {
  /** Every handle `begin` produced, in order. */
  readonly begun: readonly PatchHandle[];
  /** Handles `end` was called with, in order. */
  readonly ended: readonly PatchHandle[];
  /**
   * What each `end` was TOLD about the turn: §25.4's `on_write` observation (review finding V12).
   *
   * `undefined` is a caller that reports nothing, which the provider must read as "assume it
   * wrote" — an observation we do not have may not suppress a patch.
   */
  readonly wroteFiles: readonly (boolean | undefined)[];
  /** Handles `abandon` was called with, in order — the leak check a temp index needs. */
  readonly abandoned: readonly PatchHandle[];
  /** True while a hung `end` is still outstanding. */
  readonly hanging: boolean;
}

export function fakeDiffProvider(o: FakeDiffProviderOptions = {}): FakeDiffProvider {
  const begun: PatchHandle[] = [];
  const ended: PatchHandle[] = [];
  const wroteFiles: (boolean | undefined)[] = [];
  const abandoned: PatchHandle[] = [];
  let outstanding = 0;
  let counter = 0;

  const result = (): PatchResult => {
    const text = o.text ?? null;
    return {
      text,
      source: text === null ? null : "git",
      truncated: o.truncated ?? false,
      quality: o.quality ?? (text === null ? "unavailable" : "exact"),
      warnings: o.warnings ?? [],
    };
  };

  return {
    begun,
    ended,
    wroteFiles,
    abandoned,
    get hanging(): boolean {
      return outstanding > 0;
    },

    begin(opts: {
      cwd: string;
      workerId: WorkerId;
      signal?: AbortSignal;
    }): Promise<PatchHandle | null> {
      if (o.failBegin === true)
        return Promise.reject(new Error("fake diff provider: begin failed"));
      if (o.outsideRepo === true) return Promise.resolve(null);
      counter += 1;
      const handle: PatchHandle = {
        topLevel: opts.cwd,
        // Named, not random: a test that asserts "no temp index was left behind" needs a name it
        // can look for, and a real provider's index file is equally deterministic per turn.
        indexFile: `${opts.cwd}/.omni-fake-index-${String(counter)}`,
        tree: `fake-tree-${String(counter)}`,
        startedAtMs: 0,
      };
      begun.push(handle);
      return Promise.resolve(handle);
    },

    end(
      h: PatchHandle,
      opts?: { signal?: AbortSignal; wroteFiles?: boolean },
    ): Promise<PatchResult> {
      ended.push(h);
      wroteFiles.push(opts?.wroteFiles);
      if (o.fail === true) return Promise.reject(new Error("fake diff provider: end failed"));
      if (o.hang !== true) return Promise.resolve(result());

      outstanding += 1;
      return new Promise<PatchResult>((resolve) => {
        const signal = opts?.signal;
        const settle = (): void => {
          outstanding -= 1;
          // A provider that respects the signal stops its own work and answers honestly rather
          // than leaving the caller's race to decide. The caller has ALREADY timed out by then —
          // `#withDiffBudget` rejects first and aborts second — so this only proves the signal is
          // real and keeps the promise from being a permanent leak.
          resolve({
            text: null,
            source: null,
            truncated: false,
            quality: "unavailable",
            warnings: [],
          });
        };
        if (signal === undefined) return; // a genuine forever-hang, for the unbounded case
        if (signal.aborted) {
          settle();
          return;
        }
        signal.addEventListener("abort", settle, { once: true });
      });
    },

    abandon(h: PatchHandle): void {
      abandoned.push(h);
    },
  };
}
