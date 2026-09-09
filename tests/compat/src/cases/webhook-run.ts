import { expect } from "vitest";
import { fakeWebhookReceiver } from "@omni-acp/testkit";
import type { RunSnapshot, WebhookPayload } from "@omni-acp/protocol";
import { asRecord, type CompatCase, type CompatContext } from "./support.js";

/**
 * Compat cases for the Run API and webhook delivery.
 *
 * ONE case, and it declares `requires: ["runs"]`. No agent's `provides:` names `runs` today, so
 * every configured agent SKIPS it with `source: "capability"` and a printed reason — which is the
 * honest state of the world: `create-daemon.ts` (M2-WP-J) is what wires `deps.runs` at boot, and
 * until it does there is no Run API on a harness-built daemon to exercise. When that lands, the
 * YAML gains `runs` in `provides:` and this case starts running against every agent with no code
 * change here.
 *
 * That is deliberately not the same thing as an empty list: an empty list would say "this work
 * package recorded no case", and `OMNI_COMPAT_REQUIRE=1` would still pass. A declared case that
 * skips with a source says what is actually true, and it fails the moment `provides:` claims a
 * capability the daemon does not have.
 *
 * Owned by M2-B-WP-R.
 */
export function webhookRunCases(): readonly CompatCase[] {
  return [
    {
      id: "run-webhook",
      requires: ["runs"],
      async run(ctx: CompatContext): Promise<void> {
        const receiver = await fakeWebhookReceiver();
        try {
          // The receiver's origin is not knowable until it has bound its port, which is why this
          // is `withDaemonConfig` rather than a start-time option (M2-PLAN §1.1, follow-up 2).
          //
          // `denyCidrs: []` is ruling M2-R16's consequence, stated where it is needed: §24.6's
          // CIDR check is ABSOLUTE, so the default list (which contains `127.0.0.0/8`) would 403
          // every delivery to a loopback receiver. It belongs in THIS case's overlay and not in
          // the harness's base config — a base that disabled the SSRF control for everyone would
          // make the compat matrix the one place it is never exercised.
          await ctx.withDaemonConfig((base) => ({
            ...base,
            webhooks: {
              enabled: true,
              mode: "allowlist",
              allow: [new URL(receiver.url).origin],
              denyCidrs: [],
              secrets: { ci: "compat-webhook-secret-at-least-32-bytes" },
              timeoutMs: 5_000,
            },
          }));

          const created = await fetch(`${ctx.serverUrl}/v1/runs`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${ctx.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              agent: ctx.agentId,
              cwd: ctx.cwd,
              prompt: [{ type: "text", text: ctx.prompts.plain }],
              webhook: { url: receiver.url, secret: "ci" },
            }),
          });
          // H25: ACCEPTED. The run converges on the daemon's own time.
          expect(created.status).toBe(202);
          const run = (await created.json()) as RunSnapshot;

          const settled = await until(async () => {
            const res = await fetch(`${ctx.serverUrl}/v1/runs/${run.runId}`, {
              headers: { authorization: `Bearer ${ctx.token}` },
            });
            const snapshot = (await res.json()) as RunSnapshot;
            return ["succeeded", "failed", "cancelled"].includes(snapshot.state) ? snapshot : null;
          }, 120_000);
          expect(settled.state).toBe("succeeded");
          expect(settled.result).not.toBeNull();

          await until(() => Promise.resolve(receiver.received.length > 0 ? true : null), 30_000);

          // EXACTLY ONE delivery, EXACTLY eight keys, and a signature that verifies against the
          // configured secret and against nothing else.
          expect(receiver.received).toHaveLength(1);
          const payload = asRecord(
            JSON.parse(receiver.received[0]?.body ?? "{}"),
          ) as unknown as WebhookPayload;
          expect(Object.keys(payload).sort()).toEqual([
            "daemonId",
            "deliveryId",
            "event",
            "runId",
            "seq",
            "sessionId",
            "ts",
            "workerId",
          ]);
          expect(payload.event).toBe("run.completed");
          expect(payload.runId).toBe(run.runId);
          expect(receiver.verify(0, "compat-webhook-secret-at-least-32-bytes")).toBe(true);
          expect(receiver.verify(0, "the-wrong-secret-which-is-32-bytes!!")).toBe(false);
        } finally {
          await receiver.close();
          await ctx.withDaemonConfig(null);
        }
      },
    },
  ];
}

/** Polls until `probe` returns a non-null value. Throws with the elapsed budget on a timeout. */
async function until<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(`compat: run-webhook gave up after ${String(timeoutMs)} ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
}
