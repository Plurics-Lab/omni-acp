import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface ReceivedDelivery {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Wall-clock ms when the request headers arrived. `hang`'s test reads the gap to the abort. */
  readonly at: number;
}

export interface FakeReceiver {
  readonly url: string;
  /** Every delivery, with its headers, so the signature can be verified against a fixed vector. */
  readonly received: readonly ReceivedDelivery[];
  /** Verifies `Omni-Signature` against a secret. A wrong secret must FAIL. */
  verify(index: number, secret: string): boolean;
  /** Next N responses: a status, or "hang" to test `timeoutMs`. */
  respond(plan: readonly (number | "hang")[]): void;
  /** Sugar for the acceptance script's spelling: the next `n` attempts answer `status` (500). */
  failNext(n: number, status?: number): void;
  /** Requests whose sockets are still held open by a `"hang"` entry. */
  readonly hanging: number;
  close(): Promise<void>;
}

/** The default when the plan runs out. A receiver that has said nothing yet says `204`. */
const DEFAULT_STATUS = 204;

/**
 * A real HTTP receiver on a loopback port, because the dispatcher's contract is about HTTP:
 * `410 → failed` immediately, a hang aborted at `timeoutMs`, a `3xx` a failure that is NOT
 * followed, and the response body NEVER read.
 *
 * Two things it deliberately does NOT do.
 *
 * It does not import `@omni-acp/core`, and could not — `@omni-acp/testkit` depends on
 * `@omni-acp/protocol` alone (§3.1). So `verify` RE-IMPLEMENTS the signature from §24.3's
 * description: split `t=…,v1=…`, HMAC-SHA256 over `"<t>.<raw body>"`, compare in constant time.
 * That independence is the assertion. A receiver that verified by calling our own signer would
 * agree with us about a format we had both got wrong, which is a tautology dressed as a test.
 *
 * It does not parse the JSON before answering, and it records the RAW body text. A signature is
 * over bytes, and a receiver that verified a re-serialized object would pass for a daemon whose
 * key ordering differed from its own — the exact failure real receivers hit first.
 *
 * Owned by M2-B-WP-R.
 */
export function fakeWebhookReceiver(): Promise<FakeReceiver> {
  const received: ReceivedDelivery[] = [];
  const plan: (number | "hang")[] = [];
  /** Sockets a `"hang"` entry is holding open, so `close()` can let go of them. */
  const held = new Set<ServerResponse>();

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
      }
      received.push({ body: Buffer.concat(chunks).toString("utf8"), headers, at: Date.now() });

      const next = plan.shift() ?? DEFAULT_STATUS;
      if (next === "hang") {
        // Headers are never written and the socket is never ended: the client must be the one
        // that gives up, which is precisely what `timeoutMs` is for.
        held.add(res);
        res.on("close", () => held.delete(res));
        return;
      }
      if (next >= 300 && next < 400) {
        // A redirect the dispatcher must NOT follow. `Location` points somewhere it would be
        // very obvious about having gone.
        res.writeHead(next, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      res.writeHead(next, { "content-type": "text/plain" });
      // A body on every response, so "the response body is NEVER read" is a claim with something
      // to be wrong about.
      res.end("x".repeat(1024));
    });
  });

  return new Promise<FakeReceiver>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${String(address.port)}/hook`;

      resolve({
        url,
        received,
        verify(index: number, secret: string): boolean {
          const entry = received[index];
          if (entry === undefined) return false;
          const header = entry.headers["omni-signature"];
          if (header === undefined) return false;

          const parts = new Map<string, string>();
          for (const piece of header.split(",")) {
            const at = piece.indexOf("=");
            if (at > 0) parts.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
          }
          const t = parts.get("t");
          const v1 = parts.get("v1");
          if (t === undefined || v1 === undefined || !/^\d+$/.test(t)) return false;

          const expected = createHmac("sha256", secret)
            .update(`${t}.${entry.body}`, "utf8")
            .digest();
          const actual = Buffer.from(v1, "hex");
          // Length first: `timingSafeEqual` THROWS on a mismatch rather than returning false, and
          // a wrong-length signature is a failed verification, not an exception.
          return expected.length === actual.length && timingSafeEqual(expected, actual);
        },
        respond(next: readonly (number | "hang")[]): void {
          plan.length = 0;
          plan.push(...next);
        },
        failNext(n: number, status = 500): void {
          for (let i = 0; i < n; i++) plan.push(status);
        },
        get hanging(): number {
          return held.size;
        },
        async close(): Promise<void> {
          for (const res of held) res.destroy();
          held.clear();
          await new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            // A held socket keeps `close()` waiting forever; the destroys above plus this are
            // what make a hung-receiver test able to finish.
            server.closeAllConnections?.();
          });
        },
      });
    });
  });
}
