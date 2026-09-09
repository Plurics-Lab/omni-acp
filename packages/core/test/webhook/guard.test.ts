import { describe, expect, it } from "vitest";
import { OmniError, WebhookConfig, type ResolvedWebhookConfig } from "@omni-acp/protocol";
import { assertWebhookUrl, cidrContains, firstDenying } from "../../src/webhook/guard.js";

/**
 * The SSRF gate (§24.6). Every case runs with an INJECTED resolver, so the suite touches no DNS
 * and a "resolves into the metadata range" fixture is a fact rather than a network condition.
 *
 * Owned by M2-B-WP-R.
 */

const cfg = (overrides: Partial<ResolvedWebhookConfig> = {}): ResolvedWebhookConfig =>
  WebhookConfig.parse({ enabled: true, ...overrides });

/** A resolver with a table. Anything unlisted is a resolution FAILURE, not a silent pass. */
const resolver =
  (table: Record<string, readonly string[]>) =>
  async (host: string): Promise<readonly string[]> => {
    const found = table[host];
    if (found === undefined) throw new Error(`NXDOMAIN ${host}`);
    return await Promise.resolve(found);
  };

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "no-throw";
  } catch (e) {
    return e instanceof OmniError ? e.code : "not-an-OmniError";
  }
};

describe("assertWebhookUrl — the allowlist (control 1)", () => {
  it('mode:"allowlist" with an EMPTY allow refuses every origin, and says which', async () => {
    // FAIL CLOSED: this is the daemon's first outbound surface and the url comes from a client.
    const promise = assertWebhookUrl(
      "https://hooks.example.com/x",
      cfg({ allow: [], denyCidrs: [] }),
      resolver({ "hooks.example.com": ["93.184.216.34"] }),
    );
    await expect(promise).rejects.toThrow(/webhooks\.allow is empty/);
    expect(await codeOf(promise)).toBe("forbidden");
  });

  it("admits an exactly-matching origin and refuses a near miss", async () => {
    const config = cfg({ allow: ["https://hooks.example.com"], denyCidrs: [] });
    const dns = resolver({
      "hooks.example.com": ["93.184.216.34"],
      "evil.example.com": ["93.184.216.34"],
      "hooks.example.com.evil.test": ["93.184.216.34"],
    });

    const ok = await assertWebhookUrl("https://hooks.example.com/deep/path?q=1", config, dns);
    expect(ok.origin).toBe("https://hooks.example.com");

    // No wildcards, ever: a suffix match is how `allow: ["https://example.com"]` becomes
    // `https://example.com.attacker.test`.
    for (const url of [
      "http://hooks.example.com/x", // scheme
      "https://hooks.example.com:8443/x", // port
      "https://evil.example.com/x", // host
      "https://hooks.example.com.evil.test/x", // suffix
    ]) {
      expect(await codeOf(assertWebhookUrl(url, config, dns))).toBe("forbidden");
    }
  });

  it('mode:"any" skips the allowlist and NOTHING else', async () => {
    const dns = resolver({ "hooks.example.com": ["93.184.216.34"], meta: ["169.254.169.254"] });
    const any = cfg({ mode: "any", allow: [] });
    await expect(assertWebhookUrl("https://hooks.example.com/x", any, dns)).resolves.toBeTruthy();
    // The CIDR list still applies — "any" is about ORIGINS, not about addresses.
    expect(await codeOf(assertWebhookUrl("https://meta/x", any, dns))).toBe("forbidden");
  });

  it("refuses a scheme that is not http(s), and a url carrying credentials", async () => {
    const config = cfg({ mode: "any", denyCidrs: [] });
    const dns = resolver({ "hooks.example.com": ["93.184.216.34"] });
    expect(await codeOf(assertWebhookUrl("file:///etc/passwd", config, dns))).toBe("forbidden");
    expect(await codeOf(assertWebhookUrl("gopher://x/1", config, dns))).toBe("forbidden");
    expect(await codeOf(assertWebhookUrl("https://user:pw@hooks.example.com/x", config, dns))).toBe(
      "forbidden",
    );
    expect(await codeOf(assertWebhookUrl("not a url at all", config, dns))).toBe("bad_request");
  });
});

describe("assertWebhookUrl — denyCidrs (control 2), which is ABSOLUTE", () => {
  it("refuses a hostname that RESOLVES into denyCidrs even when its origin is allowlisted", async () => {
    // Review R16, made a test rather than a comment: an `allow` entry answers "may this ORIGIN be
    // called", `denyCidrs` answers "may this ADDRESS be called", and an allowlist that lifted the
    // second would make `webhooks.allow` the one config line that turns the daemon into a proxy
    // for the cloud metadata endpoint.
    const config = cfg({ allow: ["https://rebind.example.com"] }); // default denyCidrs
    const dns = resolver({ "rebind.example.com": ["169.254.169.254"] });
    const promise = assertWebhookUrl("https://rebind.example.com/x", config, dns);
    await expect(promise).rejects.toThrow(/169\.254\.169\.254.*169\.254\.0\.0\/16/);
    expect(await codeOf(promise)).toBe("forbidden");
  });

  it("refuses when ANY resolved address is denied, not only the first", async () => {
    const config = cfg({ allow: ["https://mixed.example.com"] });
    const dns = resolver({ "mixed.example.com": ["93.184.216.34", "10.0.0.5"] });
    expect(await codeOf(assertWebhookUrl("https://mixed.example.com/x", config, dns))).toBe(
      "forbidden",
    );
  });

  it("refuses an IPv6 answer for a name whose IPv4 answer is harmless", async () => {
    // The A/AAAA split is how a one-family check gets bypassed.
    const config = cfg({ allow: ["https://dual.example.com"] });
    const dns = resolver({ "dual.example.com": ["93.184.216.34", "::1"] });
    expect(await codeOf(assertWebhookUrl("https://dual.example.com/x", config, dns))).toBe(
      "forbidden",
    );
  });

  it("checks a LITERAL address without asking DNS at all", async () => {
    const never = async (): Promise<readonly string[]> => {
      throw new Error("the resolver must not be called for a literal address");
    };
    const config = cfg({ mode: "any" });
    expect(await codeOf(assertWebhookUrl("http://169.254.169.254/latest/", config, never))).toBe(
      "forbidden",
    );
    expect(await codeOf(assertWebhookUrl("http://[::1]:9000/hook", config, never))).toBe(
      "forbidden",
    );
    expect(await codeOf(assertWebhookUrl("http://127.0.0.1:9000/hook", config, never))).toBe(
      "forbidden",
    );
  });

  it("`denyCidrs: []` is what makes a LOOPBACK receiver reachable — the documented consequence", async () => {
    // §24.6 states this rather than leaving it to be discovered: the acceptance script,
    // `run-webhook.itest.ts` and the CI matrix all set `denyCidrs: []` for exactly this reason.
    const never = async (): Promise<readonly string[]> => {
      throw new Error("unreachable");
    };
    const url = await assertWebhookUrl(
      "http://127.0.0.1:9000/hook",
      cfg({ mode: "allowlist", allow: ["http://127.0.0.1:9000"], denyCidrs: [] }),
      never,
    );
    expect(url.href).toBe("http://127.0.0.1:9000/hook");
  });

  it("a DNS FAILURE is a refusal, never a pass", async () => {
    // An address we could not check is not a safe one.
    const config = cfg({ mode: "any" });
    expect(await codeOf(assertWebhookUrl("https://nx.example.com/x", config, resolver({})))).toBe(
      "forbidden",
    );
  });

  it("a name that resolves to NOTHING is a refusal", async () => {
    const config = cfg({ mode: "any" });
    expect(
      await codeOf(
        assertWebhookUrl(
          "https://empty.example.com/x",
          config,
          resolver({ "empty.example.com": [] }),
        ),
      ),
    ).toBe("forbidden");
  });
});

describe("cidrContains", () => {
  it("matches IPv4 on the bit, not on the byte", () => {
    expect(cidrContains("10.0.0.0/8", "10.255.255.255")).toBe(true);
    expect(cidrContains("10.0.0.0/8", "11.0.0.0")).toBe(false);
    expect(cidrContains("172.16.0.0/12", "172.31.255.255")).toBe(true);
    // 172.32.x is OUTSIDE RFC1918, and a /12 implemented as a byte compare would get it wrong.
    expect(cidrContains("172.16.0.0/12", "172.32.0.0")).toBe(false);
    expect(cidrContains("192.168.0.0/16", "192.168.1.1")).toBe(true);
    expect(cidrContains("169.254.0.0/16", "169.254.169.254")).toBe(true);
    expect(cidrContains("127.0.0.0/8", "127.0.0.1")).toBe(true);
    expect(cidrContains("0.0.0.0/0", "8.8.8.8")).toBe(true);
    expect(cidrContains("8.8.8.8/32", "8.8.8.8")).toBe(true);
    expect(cidrContains("8.8.8.8/32", "8.8.8.9")).toBe(false);
  });

  it("matches IPv6, including the compressed and mapped forms", () => {
    expect(cidrContains("::1/128", "::1")).toBe(true);
    expect(cidrContains("fe80::/10", "fe80::1")).toBe(true);
    expect(cidrContains("fe80::/10", "febf:ffff::1")).toBe(true);
    expect(cidrContains("fe80::/10", "fec0::1")).toBe(false);
    expect(cidrContains("fc00::/7", "fd00::1")).toBe(true);
    expect(cidrContains("fc00::/7", "fe00::1")).toBe(false);
    // `::ffff:127.0.0.1` IS 127.0.0.1, and must not be a way around an IPv4 deny rule.
    expect(cidrContains("127.0.0.0/8", "::ffff:127.0.0.1")).toBe(true);
    // Families do not cross otherwise.
    expect(cidrContains("10.0.0.0/8", "::1")).toBe(false);
    expect(cidrContains("::1/128", "127.0.0.1")).toBe(false);
  });

  it("answers false for a malformed rule instead of matching everything", () => {
    // The safe direction ONLY because every entry is checked: a typo denies nothing and is
    // visible as a control that stopped blocking. Treating it as a match would refuse every
    // webhook on the machine for one bad character.
    for (const bad of ["10.0.0.0", "10.0.0.0/", "10.0.0.0/x", "10.0.0.0/-1", "10.0.0.0/33", ""]) {
      expect(cidrContains(bad, "10.0.0.1")).toBe(false);
    }
    expect(cidrContains("10.0.0.0/8", "not-an-ip")).toBe(false);
  });

  it("firstDenying names the rule that refused, so the 403 can quote it", () => {
    expect(firstDenying("10.1.2.3", ["127.0.0.0/8", "10.0.0.0/8"])).toBe("10.0.0.0/8");
    expect(firstDenying("8.8.8.8", ["127.0.0.0/8", "10.0.0.0/8"])).toBeNull();
  });
});
