import { isIP } from "node:net";
import { OmniError } from "@omni-acp/protocol";
import type { ResolvedWebhookConfig, Resolver } from "@omni-acp/protocol";

/** Only these two ever reach a socket. A `file:` or `gopher:` target is not a typo to forgive. */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * The SSRF gate on the daemon's FIRST OUTBOUND SURFACE — and the URL comes from a client.
 *
 * Two controls, in order. The ALLOWLIST is primary: exact scheme+host+port, no wildcards,
 * `mode:"allowlist"` with an empty `allow` refusing everything until an operator names an origin.
 * The CIDR check over EVERY resolved address is defence in depth against DNS rebinding — a
 * hostname that resolves into `169.254.0.0/16` is the cloud metadata endpoint whatever the
 * allowlist says.
 *
 * The CIDR check is ABSOLUTE: an entry in `allow` does NOT exempt an address from `denyCidrs`
 * (review R16). The two controls answer different questions — "may this ORIGIN be called" and
 * "may this ADDRESS be called" — and an allowlist entry that lifted the SSRF gate would make
 * `webhooks.allow` the one config line that turns the daemon into a proxy for the metadata
 * endpoint. The consequence is stated rather than discovered: a LOOPBACK receiver needs
 * `denyCidrs: []`, which is why the acceptance script, `run-webhook.itest.ts` and the CI matrix
 * all set it, and why the deny-CIDR fixture uses `169.254.169.254` rather than `127.0.0.1`.
 *
 * It runs at CREATE, so the `403` reaches the operator where they can act on it, not at delivery
 * time in a background dispatcher's log (§24.6). The residual TOCTOU — a name that resolves
 * differently between this check and the connect — is accepted and recorded in §11.9.
 *
 * Owned by M2-B-WP-R.
 */
export async function assertWebhookUrl(
  raw: string,
  cfg: ResolvedWebhookConfig,
  resolve: Resolver,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OmniError("bad_request", "webhook url is not a URL");
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new OmniError("forbidden", `webhook url scheme "${url.protocol}" is not http or https`);
  }
  if (url.username !== "" || url.password !== "") {
    // Credentials in a webhook url are a secret this daemon would have to store, log and retry
    // with. Refuse them rather than quietly stripping them, which would send a request the
    // caller did not ask for.
    throw new OmniError("forbidden", "webhook url may not carry credentials");
  }

  // ── control 1: the origin allowlist ────────────────────────────────────────
  if (cfg.mode === "allowlist") {
    const allowed = cfg.allow.some((entry) => sameOrigin(entry, url));
    if (!allowed) {
      throw new OmniError(
        "forbidden",
        cfg.allow.length === 0
          ? `webhooks.allow is empty, so no origin may be called; ${url.origin} was requested`
          : `webhook origin ${url.origin} is not in webhooks.allow`,
      );
    }
  }

  // ── control 2: every RESOLVED address, absolutely ──────────────────────────
  const host = url.hostname.replace(/^\[|]$/g, "");
  const addresses = isIP(host) !== 0 ? [host] : await resolveOrRefuse(host, resolve);
  if (addresses.length === 0) {
    throw new OmniError("forbidden", `webhook host ${url.hostname} resolves to no address`);
  }
  for (const address of addresses) {
    const cidr = firstDenying(address, cfg.denyCidrs);
    if (cidr !== null) {
      throw new OmniError(
        "forbidden",
        `webhook host ${url.hostname} resolves to ${address}, which is inside denied ${cidr}`,
      );
    }
  }
  return url;
}

/** A DNS failure is a REFUSAL, never a pass: an address we could not check is not a safe one. */
async function resolveOrRefuse(host: string, resolve: Resolver): Promise<readonly string[]> {
  try {
    return await resolve(host);
  } catch (e) {
    throw new OmniError(
      "forbidden",
      `webhook host ${host} could not be resolved, so its address could not be checked ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    );
  }
}

/** Exact scheme + host + port, with the default port normalized by `URL.origin` itself. */
function sameOrigin(entry: string, url: URL): boolean {
  try {
    return new URL(entry).origin === url.origin;
  } catch {
    return false;
  }
}

/** The first CIDR that contains `address`, or null. Named so the 403 can say WHICH. */
export function firstDenying(address: string, cidrs: readonly string[]): string | null {
  for (const cidr of cidrs) if (cidrContains(cidr, address)) return cidr;
  return null;
}

/**
 * `cidr.contains(address)`, for IPv4 and IPv6, with no dependency.
 *
 * Both sides are reduced to a big-endian byte array and compared over the first `prefix` BITS,
 * which is the definition rather than an approximation of one. An IPv4 address compared against
 * an IPv6 CIDR (or the reverse) is `false` — except for the `::ffff:a.b.c.d` mapped form, which
 * IS the IPv4 address and must not be a way around an IPv4 deny rule.
 *
 * A malformed CIDR is `false` rather than a throw. That direction is deliberate and it is the
 * SAFE one only because the caller checks every entry: a typo denies nothing, and it is visible
 * as a config that stopped blocking rather than as a daemon that will not start. The opposite —
 * treating an unparseable rule as matching — would make one typo refuse every webhook.
 */
export function cidrContains(cidr: string, address: string): boolean {
  const slash = cidr.lastIndexOf("/");
  if (slash === -1) return false;
  const net = cidr.slice(0, slash);
  const width = cidr.slice(slash + 1);
  // `^\d+$` rather than `Number()`: an EMPTY prefix coerces to 0, and a `/0` matches every
  // address in its family — so `"10.0.0.0/"`, a plain typo, would silently become "deny the
  // whole internet".
  if (!/^\d+$/.test(width)) return false;
  const prefix = Number(width);

  const netBytes = toBytes(net);
  const addrBytes = toBytes(address);
  if (netBytes === null || addrBytes === null) return false;
  if (netBytes.length !== addrBytes.length) return false;
  if (prefix > netBytes.length * 8) return false;

  const whole = prefix >> 3;
  for (let i = 0; i < whole; i++) if (netBytes[i] !== addrBytes[i]) return false;
  const bits = prefix & 7;
  if (bits === 0) return true;
  const mask = (0xff << (8 - bits)) & 0xff;
  return ((netBytes[whole] ?? 0) & mask) === ((addrBytes[whole] ?? 0) & mask);
}

/** IPv4 -> 4 bytes, IPv6 -> 16 bytes, `::ffff:a.b.c.d` -> the 4 bytes it actually is. */
function toBytes(raw: string): number[] | null {
  const text = raw.replace(/^\[|]$/g, "").replace(/%.*$/, "");
  const kind = isIP(text);
  if (kind === 4) return v4(text);
  if (kind !== 6) return null;

  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(text);
  if (mapped?.[1] !== undefined) return v4(mapped[1]);

  const [head, tail] = text.split("::") as [string, string | undefined];
  const parseGroups = (s: string): number[] =>
    s === ""
      ? []
      : s.split(":").flatMap((g) => [Number.parseInt(g, 16) >> 8, Number.parseInt(g, 16) & 0xff]);
  const left = parseGroups(head);
  const right = tail === undefined ? [] : parseGroups(tail);
  const bytes =
    tail === undefined
      ? left
      : [...left, ...new Array<number>(16 - left.length - right.length).fill(0), ...right];
  return bytes.length === 16 && bytes.every((b) => Number.isInteger(b)) ? bytes : null;
}

function v4(text: string): number[] | null {
  const parts = text.split(".").map((p) => Number(p));
  return parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)
    ? parts
    : null;
}
