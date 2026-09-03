import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { sdkExampleAgentPath } from "@omni-acp/testkit";
import { describe, expect, it } from "vitest";

/**
 * The ONE real test in the M0 scaffold.
 *
 * Everything else in this repository is a signature-complete stub whose body throws, which makes
 * a green suite cheap and therefore not very informative. This test is the exception, and it
 * earns its place by proving the thing the entire M0 acceptance criterion rests on: that the
 * Tier-3 fixture — the SDK's own unmodified `dist/examples/agent.js` — resolves, launches and
 * completes an ACP handshake over real stdio pipes ON THIS MACHINE, on all three CI runners,
 * before a single work package starts.
 *
 * Three details are load-bearing and each one is a bug the scaffold would otherwise hand to WP-2:
 *
 *  - Launched as `process.execPath <path>`, never through `npx`. On Windows `npx` is a `.cmd`
 *    shim, and since the CVE-2024-27980 fix `spawn()` throws EINVAL for `.cmd` without
 *    `shell: true` (CONTRACTS.md §6.3). The direct-module form is also one fewer process in the
 *    tree — exactly the layer that makes Windows tree kill unreliable.
 *  - The path comes from `sdkExampleAgentPath()`, which derives it from the SDK's MAIN ENTRY.
 *    The SDK's `exports` map publishes neither `./package.json` nor `./dist/examples/*`, so
 *    resolving either directly throws ERR_PACKAGE_PATH_NOT_EXPORTED (F8).
 *  - `ndJsonStream(output, input)` takes what WE WRITE first (the child's stdin) and what we READ
 *    second (the child's stdout). The SDK's own example names these locals misleadingly (F6), and
 *    swapping them produces a hang rather than an error — which is the worst kind of bug to
 *    discover from inside a supervisor.
 */
describe("SDK example agent fixture", () => {
  it("handshakes over real stdio pipes", async () => {
    const child = spawn(process.execPath, [sdkExampleAgentPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });

    try {
      expect(child.stdin).not.toBeNull();
      expect(child.stdout).not.toBeNull();

      // F6: (what we write) then (what we read). Not the other way round.
      const stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin!),
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      );

      const result = await acp
        .client({ name: "omni-acp-scaffold-smoke" })
        .connectWith(stream, (ctx) =>
          ctx.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            // D3: M0 advertises no client capabilities at all.
            clientCapabilities: {},
          }),
        );

      expect(result.protocolVersion).toBe(1);
      // The fixture answers `loadSession: false`, which is what makes it an M0 fixture: no
      // session/load means no resume path to get wrong (D2/D6 are M1).
      expect(result.agentCapabilities?.loadSession).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });
});
