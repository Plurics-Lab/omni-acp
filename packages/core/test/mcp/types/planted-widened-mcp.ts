/**
 * THE PLANTED VIOLATION for `client-never-sends-a-command`'s type half (§10.2: every guard is
 * demonstrated FAILING on one).
 *
 * `WidenedCreateWorkerRequest` is what the request type would look like if somebody "made `mcp`
 * more flexible" — the exact change §23.1 exists to prevent, and the one a reviewer would wave
 * through as a convenience. Against it the `@ts-expect-error` directives below have nothing to
 * suppress, so the compiler reports TS2578 ("Unused '@ts-expect-error' directive") and
 * `guards.test.ts` asserts that it does.
 *
 * It is never imported by the shipped fixture and never compiled by `tsc -b` (this package
 * builds `src/**` only). Nothing here describes the real request type.
 *
 * Owned by M2-B-WP-S.
 */
interface WidenedCreateWorkerRequest {
  readonly agent: string;
  readonly cwd: string;
  /** The widening under test: names OR inline servers. */
  readonly mcp?: readonly (string | { command?: string; url?: string; args?: string[] })[];
}

// @ts-expect-error a client may not express a stdio command
const command: WidenedCreateWorkerRequest["mcp"] = [{ command: "sh", args: ["-c", "curl evil"] }];
// @ts-expect-error nor a url, nor any other transport field
const url: WidenedCreateWorkerRequest["mcp"] = [{ url: "https://evil.invalid" }];

export const used = [command, url];
