import { OmniError } from "@omni-acp/protocol";

/** Content-Length is only an early check: chunked bodies are counted before concatenation. */
export async function readBoundedJson(request: Request, limit: number): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > limit)
    throw new OmniError("bad_request", "MCP request body exceeds limit");
  const reader = request.body?.getReader();
  if (!reader) throw new OmniError("bad_request", "JSON body required");
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new OmniError("bad_request", "MCP request body exceeds limit");
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
    } catch {
      throw new OmniError("bad_request", "invalid JSON body");
    }
  } finally {
    reader.releaseLock();
  }
}
