/**
 * A TYPE fixture, not a test: it is never executed. `guards.test.ts` type-checks it with the
 * TypeScript compiler API and asserts ZERO diagnostics.
 *
 * It is the TYPE half of `client-never-sends-a-command` (§23.1, §27.4). DESIGN §8's 🔴 says a
 * client may name a preset and may never express a command, and M2 makes that a TYPE rather than
 * a validator somebody could move: `CreateWorkerRequest.mcp` and `CreateRunRequest.mcp` are
 * `string[]`, and `McpServerPreset.command` is reachable only from `DaemonConfig`.
 *
 * The `@ts-expect-error` lines carry the load. Each one FAILS THE FIXTURE if the assignment ever
 * starts compiling — which is exactly what widening `mcp` to accept an object would do — so
 * "zero diagnostics" proves both halves at once: the string form is accepted and the command
 * form is not.
 *
 * It imports the BUILT declarations, so what is proven is what consumers get.
 *
 * Owned by M2-B-WP-S.
 */
import type {
  CreateRunRequest,
  CreateWorkerRequest,
  McpServerPreset,
  ResolvedDaemonConfig,
} from "../../../../protocol/dist/index.js";

declare const worker: CreateWorkerRequest;
declare const run: CreateRunRequest;

// NAMES, on both request types. Nothing else is on this wire.
const workerNames: readonly string[] | undefined = worker.mcp;
const runNames: readonly string[] | undefined = run.mcp;

// @ts-expect-error a client may not express a stdio command
const workerCommand: CreateWorkerRequest["mcp"] = [{ command: "sh", args: ["-c", "curl evil"] }];
// @ts-expect-error a client may not express a stdio command
const runCommand: CreateRunRequest["mcp"] = [{ command: "sh" }];
// @ts-expect-error nor a url, nor any other transport field
const workerUrl: CreateWorkerRequest["mcp"] = [{ type: "http", url: "https://evil.invalid" }];

// The other half of the same rule: a `command` exists, and it is reachable ONLY from the
// operator's config. If this stopped compiling, the preset table would have lost its command and
// the guard would be protecting nothing.
declare const config: ResolvedDaemonConfig;
const preset: McpServerPreset | undefined = config.mcpServers["files"];
const command: string | undefined = preset?.command;

export const used = [workerNames, runNames, workerCommand, runCommand, workerUrl, command];
