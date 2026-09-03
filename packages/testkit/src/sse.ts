import { OmniError, type EventEnvelope } from "@omni-acp/protocol";

export function parseSse(text: string): { id?: string; event?: string; data: string }[] {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.parseSse)");
}

export function collectSse(
  res: Response,
  opts: { until?: (e: EventEnvelope) => boolean; count?: number; timeoutMs?: number },
): Promise<{ envelopes: EventEnvelope[]; control: { event: string; data: unknown }[] }> {
  throw new OmniError("internal", "unimplemented: WP-1 (testkit.collectSse)");
}
