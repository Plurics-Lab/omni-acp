import { randomBytes } from "node:crypto";
import { OmniError, type DaemonConfig } from "@omni-acp/protocol";
import { connectServer, type Server } from "./server.js";

export interface LocalOptions {
  /**
   * M0 default: `"never"` — a bare `OmniACP.local()` always starts a fresh embedded daemon.
   *
   * DESIGN D14's canonical example writes `adopt: "prefer"`; discovery and reuse of a running
   * daemon through `~/.omni-acp/daemon.json` arrives with the other adopt modes in M3, and until
   * then `"prefer"` and `"require"` throw `bad_request` naming M3 (review R13, CONTRACTS.md L11).
   */
  readonly adopt?: "prefer" | "never" | "require";
  /** M0: true throws until M3. */
  readonly detach?: boolean;
  readonly dataDir?: string;
  readonly config?: Partial<DaemonConfig>;
}

/** One entry of `DaemonConfig.tokens`, as the caller may supply it (the zod INPUT shape). */
type TokenInput = NonNullable<DaemonConfig["tokens"]>[number];

/** ESM and CJS spell it differently, and a bundler can add a third. All three mean "absent". */
const MODULE_ABSENT = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
]);

const ABSENT_PEER_MESSAGE =
  "OmniACP.local() starts an embedded daemon and needs the optional peer @omni-acp/daemon, " +
  "which is not installed. Run `npm i @omni-acp/daemon`, or use OmniACP.connect({url, token}) " +
  "against a daemon you already run.";

function isModuleAbsent(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && MODULE_ABSENT.has(code);
}

/**
 * The optional peer, reached ONLY here and ONLY dynamically.
 *
 * A module-not-found stack is a bad answer to "why did local() fail": it names a resolution
 * algorithm instead of the one command that fixes it. Any OTHER failure — a daemon that throws
 * while evaluating, a broken install — is re-thrown as itself, because swallowing it into the
 * "not installed" message would send the caller to reinstall a package that is already there.
 */
async function importDaemon(): Promise<typeof import("@omni-acp/daemon")> {
  try {
    return await import("@omni-acp/daemon");
  } catch (e) {
    if (!isModuleAbsent(e)) throw OmniError.from(e, "internal");
    throw new OmniError("bad_request", ABSENT_PEER_MESSAGE, { cause: e });
  }
}

/**
 * D14, implemented for `adopt: "never", detach: false` — which is also the M0 end-to-end harness,
 * so D14 and D15 share one code path from day one.
 *
 * `@omni-acp/daemon` is reached ONLY through `await import("@omni-acp/daemon")` inside this
 * function. It is an OPTIONAL peer dependency, never a static import — the
 * `client-has-no-daemon-import` guard fails on one, and a test imports the built client with the
 * daemon absent from `node_modules`. When it is absent, this throws a message naming
 * `npm i @omni-acp/daemon`, not a module-not-found stack.
 *
 * The embedded daemon binds `127.0.0.1:0` with a generated admin token and is then reached by an
 * ordinary `connect()` over loopback HTTP — no in-memory shortcut, which is what makes the
 * bad-token `401` in `local-mode.itest.ts` meaningful.
 */
export async function local(opts?: LocalOptions): Promise<Server> {
  const adopt = opts?.adopt ?? "never";
  if (adopt !== "never") {
    throw new OmniError(
      "bad_request",
      `OmniACP.local({adopt:"${adopt}"}) is not implemented until M3 — M0 supports adopt:"never", ` +
        "which always starts a fresh embedded daemon (daemon.json discovery and reuse are M3).",
    );
  }
  if (opts?.detach === true) {
    throw new OmniError(
      "bad_request",
      "OmniACP.local({detach:true}) is not implemented until M3 — M0's embedded daemon lives and " +
        "dies with this process.",
    );
  }

  const { createDaemon } = await importDaemon();

  // 32 bytes of CSPRNG, hex — comfortably over TokenConfig's 16-character floor, and never
  // written to disk by this path: M0's local daemon exists only for the lifetime of this process.
  const secret = randomBytes(32).toString("hex");

  const supplied = opts?.config ?? {};
  // A caller's token entry is honoured for its ACL (`agents`, `cwdRoots`, `maxWorkers`) and
  // nothing else: the secret is ours, the role is admin, and any `secretSha256` is dropped
  // because TokenConfig accepts exactly one of secret / secretSha256.
  const suppliedToken: TokenInput = supplied.tokens?.[0] ?? { id: "local" };
  const { secretSha256: _hash, secret: _plain, ...acl } = suppliedToken;

  const config: DaemonConfig = {
    ...supplied,
    ...(opts?.dataDir === undefined ? {} : { dataDir: opts.dataDir }),
    // Forced, not merged: `local()` means loopback on an ephemeral port. Anything else is
    // `createDaemon()` directly, which is a supported thing to do (D15).
    listen: { host: "127.0.0.1", port: 0 },
    tokens: [{ ...acl, secret, role: "admin" }],
  };

  const daemon = await createDaemon(config);
  await daemon.start();

  const url = daemon.url;
  if (url === null) {
    await daemon.stop({ graceful: true }).catch(() => {});
    throw new OmniError("internal", "the embedded daemon started without binding a socket");
  }

  try {
    // An ORDINARY connect over real loopback HTTP. No in-memory transport, which is what makes
    // the bad-token 401 in local-mode.itest.ts a meaningful proof rather than a tautology.
    return await connectServer(
      {
        url,
        token: secret,
        clientId: `c_local_${String(process.pid)}`,
        fetch: (input, init) => globalThis.fetch(input, init),
        requestTimeoutMs: 30_000,
      },
      // `server.close()` stops the daemon it started — and only the one it started.
      () => daemon.stop({ graceful: true }),
    );
  } catch (e) {
    await daemon.stop({ graceful: true }).catch(() => {});
    throw e;
  }
}
