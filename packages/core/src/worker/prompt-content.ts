import { posix, win32 } from "node:path";
import { OmniError } from "@omni-acp/protocol";
import type { PromptCapabilities } from "@omni-acp/protocol";

/**
 * §26 / H28: the containment check that M0's zod `.refine` could not perform, because zod holds
 * no worker and DESIGN §5.1 requires BOTH this agent's `promptCapabilities` and this token's
 * `cwdRoots`.
 *
 * It throws `bad_request` BEFORE the prompt is sent, and "before" is the entire acceptance: in
 * every rejected case the fixture agent must record ZERO `session/prompt` calls (F37, F38). Once
 * a path reaches the agent, D3 says the agent reads the disk itself, and the containment question
 * is already answered the wrong way.
 *
 * REALPATH FIRST, then contain — a symlink inside `cwd` that resolves outside it is the case a
 * string comparison passes and this must not. The rejections, in full: a `resource_link` outside
 * `cwdRoots`; such a symlink; a relative or non-`file://` uri; a `..` traversal; an embedded
 * `resource` block failing any of the above; and a block type the worker's `promptCapabilities`
 * does not advertise.
 *
 * The message ELIDES the path, for `ids.ts`'s reason: the value came from the wire, and echoing
 * it back is how a reflected-value log line is born.
 *
 * Owned by M2-B-WP-S.
 */

/**
 * The ONE refusal message every path-shaped rejection shares.
 *
 * It elides the path, and it also elides WHY: "does not exist", "is not readable" and "resolves
 * outside your roots" are one sentence on purpose. Three sentences would make the 400 a
 * filesystem oracle — a probe would learn which paths exist by which message came back — and
 * that is the same reasoning `assertCwd` gives for answering 403 rather than 404.
 */
const OUTSIDE = "does not resolve to a path inside an allowed root";

/** v1's `promptCapabilities` keys that gate a block type. Resource links are NOT among them. */
const GATED = { image: "image", audio: "audio" } as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const reject = (index: number, type: string, why: string): OmniError =>
  new OmniError("bad_request", `prompt content block ${String(index)} (${type}) ${why}`, {
    // NO PATH, in the message OR the detail. `detail` is the half of an `OmniError` that is
    // logged rather than returned, and a value that came off the wire is exactly what must not
    // be reflected into a log line. The index and the type are ours.
    detail: { blockIndex: index, blockType: type },
  });

/** `path.win32` / `path.posix` chosen by an INJECTED platform, so both branches run everywhere. */
function pathFor(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? (win32 as unknown as typeof posix) : posix;
}

/**
 * `child` is inside `parent` (or IS `parent`).
 *
 * `relative` rather than `startsWith`: `/srv/workspace-evil` starts with `/srv/workspace` and is
 * not inside it. `path.win32.relative` folds case, which is the comparison Windows actually
 * performs.
 */
function contains(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const rel = p.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/**
 * A `file://` uri → an absolute path on `platform`, or `null` when it is not one.
 *
 * Written against `platform` rather than reached for through `node:url`'s `fileURLToPath`, whose
 * answer depends on the platform the PROCESS runs on: `file:///C:/x` is `C:\x` on Windows and
 * `/C:/x` on Linux, so a Windows-shape test on a Linux runner would exercise the wrong branch
 * and pass. Both branches have to be reachable from one machine, which is the same reason
 * `resolveWorkerEnv` takes a `platform`.
 *
 * The rejections here are the "relative or non-`file://` uri" row of §26.2's table, plus two
 * that the row implies: a uri with a HOST (`file://server/share` is a remote path, not this
 * machine's) and a percent-encoded NUL (a path that is truncated at the syscall boundary is not
 * the path we checked).
 */
export function fileUriToPath(uri: string, platform: NodeJS.Platform): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    // A RELATIVE uri lands here: `new URL("notes.txt")` throws with no base, and a base is
    // exactly what we refuse to supply — resolving a relative path against `cwd` would make the
    // client's uri mean something different depending on which worker received it.
    return null;
  }
  if (url.protocol !== "file:") return null;
  // RFC 8089 allows an empty authority and "localhost"; anything else is another machine.
  if (url.hostname !== "" && url.hostname !== "localhost") return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return null; // a malformed percent escape is not a path
  }
  if (decoded.includes("\0")) return null;
  if (!decoded.startsWith("/")) return null;

  // A `..` SEGMENT, rejected before anything touches the disk. `realpath` would resolve it and
  // containment would then catch the result, but refusing here means an attacker-chosen
  // traversal never becomes a syscall, and it is the row §26.2 lists in its own right.
  const segments = decoded.split("/");
  if (segments.includes("..")) return null;

  if (platform !== "win32") {
    return posix.isAbsolute(decoded) ? decoded : null;
  }

  // `/C:/Users/x` → `C:\Users\x`. A pathname that is not drive-rooted (`/Users/x`) has no
  // meaning as a Windows absolute path, and inventing a drive letter for it would be guessing.
  const drive = /^\/([A-Za-z]:)(\/|$)/.exec(decoded);
  if (drive === null) return null;
  const windows = decoded.slice(1).split("/").join("\\");
  return win32.isAbsolute(windows) ? windows : null;
}

interface Gate {
  readonly roots: readonly string[];
  readonly platform: NodeJS.Platform;
  readonly realpath: (p: string) => Promise<string>;
}

/**
 * `realpath` FIRST, contain SECOND — the order IS the control.
 *
 * A symlink at `<cwd>/link` pointing at `/etc/shadow` passes every string comparison anybody
 * would write and fails this one. Getting the order backwards produces a check that looks
 * identical in review and stops nothing.
 */
async function assertContained(gate: Gate, raw: string): Promise<void> {
  let canonical: string;
  try {
    canonical = await gate.realpath(raw);
  } catch {
    // Unreadable or absent: containment is UNPROVABLE, so it fails closed — and it fails with
    // the same sentence as "outside", so the reply distinguishes neither.
    throw new Error(OUTSIDE);
  }
  for (const root of gate.roots) {
    if (contains(root, canonical, gate.platform)) return;
  }
  throw new Error(OUTSIDE);
}

/** The uri of a `resource_link` / embedded `resource`, or `null` when the block has none. */
function uriOf(block: Record<string, unknown>, key: "uri" | "resource"): unknown {
  if (key === "uri") return Object.hasOwn(block, "uri") ? block["uri"] : undefined;
  const inner = Object.hasOwn(block, "resource") ? block["resource"] : undefined;
  return isRecord(inner) && Object.hasOwn(inner, "uri") ? inner["uri"] : undefined;
}

export async function assertPromptContent(o: {
  content: readonly unknown[];
  cwd: string;
  cwdRoots: readonly string[];
  promptCapabilities: PromptCapabilities | null;
  realpath: (p: string) => Promise<string>;
  /**
   * OPTIONAL, and defaulted to this process's platform, so the daemon's binding is unchanged and
   * a test can still exercise the Windows path shapes on a Linux runner (§10.3's rule that a
   * Windows branch must COMPILE and must be reachable, even where a real Windows observation is
   * `skipIf`-gated).
   */
  platform?: NodeJS.Platform;
}): Promise<readonly unknown[]> {
  const platform = o.platform ?? process.platform;

  if (o.content.length === 0) {
    // M0's first rule, unchanged: `PromptRequestBody` says `.min(1)` and an in-process caller is
    // not bound by it.
    throw new OmniError("bad_request", "prompt content is empty");
  }

  // Built at most ONCE per call, and only when a path-bearing block actually appears — a
  // text-only prompt (which is every M0 and M1 prompt) costs zero syscalls, which is what keeps
  // acceptance 9's "the M0 text-only path still works" true of the latency as well as the shape.
  let gate: Gate | null = null;
  const gateFor = async (): Promise<Gate> => {
    if (gate !== null) return gate;

    if (o.cwdRoots.length === 0) {
      // FAIL CLOSED and LOUDLY. An empty root list is a gate that was bound wrong, not a token
      // that may read the whole filesystem, and `internal` says whose fault it is: the client
      // did nothing a 400 would help it fix.
      throw new OmniError("internal", "prompt containment is mis-bound: no cwdRoots");
    }

    // The roots are canonicalised too, for `assertCwd`'s reason: `/tmp` is a symlink to
    // `/private/tmp` on macOS, and a root that did not canonicalise would reject every path
    // underneath it.
    const roots: string[] = [];
    for (const root of o.cwdRoots) {
      roots.push(await o.realpath(root).catch(() => root));
    }

    // The worker's `cwd` is not a root — the token's `cwdRoots` are (§26.2) — but it MUST lie
    // inside one. The daemon binds this gate to a cwd that `assertCwd` already canonicalised and
    // contained, so this can only fire for a mis-bound gate; firing loudly the first time a
    // prompt carries a path is far better than discovering the mis-binding from a widened
    // containment check that quietly allowed something.
    const canonicalCwd = await o.realpath(o.cwd).catch(() => o.cwd);
    if (!roots.some((root) => contains(root, canonicalCwd, platform))) {
      throw new OmniError("internal", "prompt containment is mis-bound: cwd is outside cwdRoots");
    }

    gate = { roots, platform, realpath: o.realpath };
    return gate;
  };

  for (const [index, raw] of o.content.entries()) {
    if (!isRecord(raw)) {
      throw new OmniError("bad_request", `prompt content block ${String(index)} is not an object`);
    }
    const type = raw["type"];
    if (typeof type !== "string") {
      throw new OmniError(
        "bad_request",
        `prompt content block ${String(index)} has no string "type"`,
      );
    }

    if (type === "text") {
      // Always accepted — and still required to CARRY text, which is M0's whitelist unchanged.
      if (typeof raw["text"] !== "string") {
        throw reject(index, type, "has no string text");
      }
      continue;
    }

    if (type === GATED.image || type === GATED.audio) {
      // 400 unless the worker's OWN handshake advertised it, and never forwarded. F37 records
      // claude-acp advertising `{image: true, embeddedContext: true}`; an agent that did not is
      // an agent that will answer in prose about a block it could not decode.
      const advertised = o.promptCapabilities !== null && Object.hasOwn(o.promptCapabilities, type);
      if (!advertised) {
        throw reject(index, type, "is not advertised by this agent's promptCapabilities");
      }
      continue;
    }

    if (type === "resource_link" || type === "resource") {
      // NOT gated on a capability, deliberately: neither real agent advertises anything for
      // resource links and both accept them (F37, F38), so gating on `embeddedContext` would
      // break both for no security gain. Containment is the control.
      const uri = uriOf(raw, type === "resource_link" ? "uri" : "resource");
      if (typeof uri !== "string" || uri.length === 0) {
        throw reject(index, type, "has no string uri");
      }
      const path = fileUriToPath(uri, platform);
      if (path === null) {
        throw reject(index, type, "is not an absolute file:// uri without traversal");
      }
      try {
        await assertContained(await gateFor(), path);
      } catch (e) {
        if (e instanceof OmniError) throw e; // the mis-bound-gate `internal`, unmodified
        throw reject(index, type, OUTSIDE);
      }
      continue;
    }

    // Anything else, NAMING the type — the type is a short token off the wire, so it is quoted
    // and clamped like every other echo.
    const shown = type.length <= 32 ? type : `${type.slice(0, 32)}…`;
    throw new OmniError(
      "bad_request",
      `prompt content block ${String(index)} has unsupported type ${JSON.stringify(shown)}`,
      { detail: { blockIndex: index, blockType: shown } },
    );
  }

  // Returned UNCHANGED, by identity. Substituting each canonical path for the one the client
  // sent would look like a hardening step and would not be one — the agent still reads the disk
  // seconds later (the residual TOCTOU §11.9 records) — while destroying the audit trail's
  // record of what was actually asked for.
  return o.content;
}
