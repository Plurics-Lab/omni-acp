import { OmniError } from "@omni-acp/protocol";

export interface FakeReceiver {
  readonly url: string;
  /** Every delivery, with its headers, so the signature can be verified against a fixed vector. */
  readonly received: readonly {
    readonly body: string;
    readonly headers: Readonly<Record<string, string>>;
  }[];
  /** Verifies `Omni-Signature` against a secret. A wrong secret must FAIL. */
  verify(index: number, secret: string): boolean;
  /** Next N responses: a status, or "hang" to test `timeoutMs`. */
  respond(plan: readonly (number | "hang")[]): void;
  close(): Promise<void>;
}

/**
 * A real HTTP receiver on a loopback port, because the dispatcher's contract is about HTTP:
 * `410 → failed` immediately, a hang aborted at `timeoutMs`, a `3xx` a failure that is NOT
 * followed, and the response body NEVER read.
 *
 * Owned by M2-B-WP-R.
 */
export function fakeWebhookReceiver(): Promise<FakeReceiver> {
  throw new OmniError("internal", "unimplemented: M2-B-WP-R");
}
