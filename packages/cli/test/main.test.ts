import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { main } from "@omni-acp/cli";
import { describe, expect, it } from "vitest";

/** A `WritableStream` that keeps what was written, so `main()` needs no process streams. */
function capture(): { stream: NodeJS.WritableStream; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

function io(): {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  out: () => string;
  err: () => string;
} {
  const stdout = capture();
  const stderr = capture();
  return { stdout: stdout.stream, stderr: stderr.stream, out: stdout.text, err: stderr.text };
}

/**
 * `main()` returns an exit code instead of calling `process.exit`, which is the only reason it
 * can be tested at all. The paths that start a daemon belong to
 * `tests/integration/src/cli-start.itest.ts`, which runs the real binary as a real child on all
 * three OSes; what is here is everything that resolves before a socket exists.
 */
describe("main", () => {
  it("prints usage on stdout and exits 0 for --help", async () => {
    const streams = io();
    const code = await main(["--help"], {}, streams);

    expect(code).toBe(0);
    expect(streams.out()).toContain("omni-acp start");
    expect(streams.out()).toContain("--print-token");
    expect(streams.err()).toBe("");
  });

  it("prints the package version on stdout and exits 0 for --version", async () => {
    const streams = io();
    const code = await main(["--version"], {}, streams);

    expect(code).toBe(0);
    expect(streams.out().trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits 2 with the reason and the usage on STDERR for an unknown flag", async () => {
    // WP-6 acceptance 9. Exit 2 is the shell's "you typed it wrong"; usage on stderr keeps
    // `omni-acp start | jq` from being fed a help screen.
    const streams = io();
    const code = await main(["start", "--wat"], {}, streams);

    expect(code).toBe(2);
    expect(streams.err()).toContain('unknown flag "--wat"');
    expect(streams.err()).toContain("Usage:");
    expect(streams.out()).toBe("");
  });

  it("exits 2 for an unknown command", async () => {
    const streams = io();
    expect(await main(["serve"], {}, streams)).toBe(2);
    expect(streams.err()).toContain('unknown command "serve"');
  });

  it("exits 1 with a readable message when the config file does not exist", async () => {
    const streams = io();
    const code = await main(["start", "--config", "definitely-not-here.yaml"], {}, streams);

    expect(code).toBe(1);
    expect(streams.err()).toContain("omni-acp:");
    expect(streams.err()).toContain("definitely-not-here.yaml");
    // A config problem is not a usage problem: the flags were fine.
    expect(streams.out()).toBe("");
  });

  it("does not write the generated token to stdout unless asked", async () => {
    // The token is a credential. `--print-token` is opt-in precisely so that the common case —
    // a daemon started under a supervisor whose stdout goes to a log file — does not put one
    // there.
    //
    // Proven through a start that reaches the token step and then fails to BIND: `192.0.2.1` is
    // TEST-NET-1 (RFC 5737), an address no machine on any of the three OSes owns, so `listen`
    // fails with EADDRNOTAVAIL and `main()` returns 1 without ever holding a socket open. A
    // successful start would block until a signal, which is `cli-start.itest.ts`'s job — this is
    // a unit test and must not bind, wait, or write to a developer's `~/.omni-acp`, hence the
    // temp `--data-dir` too.
    const dataDir = await mkdtemp(join(tmpdir(), "omni-acp-cli-"));
    try {
      const streams = io();
      const code = await main(
        ["start", "--host", "192.0.2.1", "--port", "0", "--data-dir", dataDir],
        { OMNI_ACP_TOKEN: "sekrit-token-that-is-long" },
        streams,
      );

      expect(code).toBe(1);
      expect(streams.err()).toContain("failed to start");
      expect(streams.out()).not.toContain("sekrit-token-that-is-long");
      expect(streams.err()).not.toContain("sekrit-token-that-is-long");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
