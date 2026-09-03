import { parseArgs, type ParsedArgs } from "@omni-acp/cli";
import { describe, expect, it } from "vitest";

/**
 * `parseArgs` is pure by contract (CONTRACTS.md §5.6): argv in, a decision out, no I/O and no
 * `process.exit`. That is what lets the whole surface be a table.
 */
const CASES: readonly { argv: string[]; expected: ParsedArgs }[] = [
  { argv: [], expected: { cmd: "help" } },
  { argv: ["help"], expected: { cmd: "help" } },
  { argv: ["--help"], expected: { cmd: "help" } },
  { argv: ["-h"], expected: { cmd: "help" } },
  { argv: ["start", "--help"], expected: { cmd: "help" } },
  { argv: ["version"], expected: { cmd: "version" } },
  { argv: ["--version"], expected: { cmd: "version" } },
  { argv: ["-v"], expected: { cmd: "version" } },

  { argv: ["start"], expected: { cmd: "start" } },
  { argv: ["start", "--port", "0"], expected: { cmd: "start", port: 0 } },
  { argv: ["start", "--port=8080"], expected: { cmd: "start", port: 8080 } },
  { argv: ["start", "-p", "65535"], expected: { cmd: "start", port: 65535 } },
  { argv: ["start", "--host", "0.0.0.0"], expected: { cmd: "start", host: "0.0.0.0" } },
  { argv: ["start", "--config", "d.yaml"], expected: { cmd: "start", configPath: "d.yaml" } },
  { argv: ["start", "-c", "d.yaml"], expected: { cmd: "start", configPath: "d.yaml" } },
  { argv: ["start", "--data-dir", "/var/omni"], expected: { cmd: "start", dataDir: "/var/omni" } },
  { argv: ["start", "--print-token"], expected: { cmd: "start", printToken: true } },
  {
    argv: ["start", "-c", "d.yaml", "--host", "127.0.0.1", "--port", "0", "--print-token"],
    expected: {
      cmd: "start",
      configPath: "d.yaml",
      host: "127.0.0.1",
      port: 0,
      printToken: true,
    },
  },
  // A Windows path with a drive letter survives `--config=C:\...`: only the FIRST `=` splits.
  {
    argv: ["start", "--config=C:\\omni\\daemon.yaml"],
    expected: { cmd: "start", configPath: "C:\\omni\\daemon.yaml" },
  },

  { argv: ["serve"], expected: { cmd: "error", message: 'unknown command "serve"' } },
  { argv: ["--wat"], expected: { cmd: "error", message: 'unknown flag "--wat"' } },
  { argv: ["start", "--wat"], expected: { cmd: "error", message: 'unknown flag "--wat"' } },
  { argv: ["start", "--wat=1"], expected: { cmd: "error", message: 'unknown flag "--wat"' } },
  { argv: ["start", "extra"], expected: { cmd: "error", message: 'unexpected argument "extra"' } },
  { argv: ["start", "--port"], expected: { cmd: "error", message: 'flag "--port" needs a value' } },
  // A flag where a value belongs is a forgotten argument, not a hostname called "--host".
  {
    argv: ["start", "--port", "--host"],
    expected: { cmd: "error", message: 'flag "--port" needs a value' },
  },
  {
    argv: ["start", "--port", "eight"],
    expected: { cmd: "error", message: '--port must be an integer, got "eight"' },
  },
  {
    argv: ["start", "--port", "99999"],
    expected: { cmd: "error", message: '--port must be between 0 and 65535, got "99999"' },
  },
  {
    argv: ["start", "--print-token=yes"],
    expected: { cmd: "error", message: 'flag "--print-token" takes no value' },
  },
];

describe("parseArgs", () => {
  for (const { argv, expected } of CASES) {
    it(`parses ${JSON.stringify(argv)}`, () => {
      expect(parseArgs(argv)).toEqual(expected);
    });
  }

  it("does not mutate the argv it is given", () => {
    const argv = ["start", "--port", "0"];
    const copy = [...argv];
    parseArgs(argv);
    expect(argv).toEqual(copy);
  });
});
