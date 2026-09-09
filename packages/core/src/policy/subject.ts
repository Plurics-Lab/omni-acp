import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { InteractionRequest, PolicySubject } from "@omni-acp/protocol";

/**
 * The v2-mapped request -> the thing rules match on.
 *
 * Two details carry the whole file:
 *
 *  - **realpath, then contain.** A symlink inside `src/` that resolves outside it must NOT
 *    satisfy `src/**`; comparing the written path would let a symlink author a permission.
 *  - **a file that does not exist yet.** A create names a path with no inode, so the deepest
 *    EXISTING ancestor is realpath'd and the remainder re-appended. Without that, every `allow`
 *    rule for `src/**` fails on exactly the writes it exists to permit.
 *
 * TOTAL: a shape it cannot read yields a subject whose `type` no rule matches, which falls to
 * `default`. A permission request that threw here would hang a turn on a JSON-RPC id (F1), so
 * there is nothing this function may refuse.
 *
 * Owned by M2-B-WP-P.
 */

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * The deepest EXISTING ancestor, realpath'd, with the missing remainder re-appended.
 *
 * A create is the case that matters: `src/new-file.ts` has no inode yet, so a plain realpath
 * rejects and the path a rule was written for never reaches the matcher. Walking up until one
 * link resolves keeps the symlink guarantee (the ancestor is canonical) while still naming the
 * file the agent actually asked about.
 */
async function realpathDeep(
  raw: string,
  cwd: string,
  realpath: (p: string) => Promise<string>,
): Promise<string> {
  const start = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
  let cursor = start;
  const tail: string[] = [];
  for (;;) {
    try {
      const resolved = await realpath(cursor);
      return tail.length === 0 ? resolved : join(resolved, ...tail);
    } catch {
      const parent = dirname(cursor);
      // The filesystem root cannot be walked past. Nothing on this path exists, so the lexically
      // resolved absolute is the honest answer - and it is still an absolute, which is what the
      // matcher requires.
      if (parent === cursor) return start;
      tail.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function toPolicySubject(
  req: InteractionRequest,
  ctx: { cwd: string; agentId: string; realpath: (p: string) => Promise<string> },
): Promise<PolicySubject> {
  const subject = asRecord(req.subject);
  const tag = subject === null ? null : asString(subject["type"]);

  /**
   * A permission always carries a tagged subject; an elicitation carries none, and D10 makes the
   * two ONE lifecycle - `PolicyMatch.method` can name `elicitation/create`, so an elicitation has
   * to be addressable or that enum member is dead. It gets its own tag rather than a v2 one, so a
   * rule written for `subject: tool_call` can never accidentally reach it.
   *
   * A permission with NO readable subject falls to `"unknown"`, which matches no rule at all and
   * therefore lands on `default` - v2's "unknown subjects should be preserved or declined by
   * policy", read as fail-closed.
   */
  const type =
    tag ?? (req.method === "elicitation/create" && subject === null ? "elicitation" : "unknown");

  const toolCall = type === "tool_call" && subject !== null ? asRecord(subject["toolCall"]) : null;

  const paths: string[] = [];
  if (toolCall !== null) {
    const locations = toolCall["locations"];
    if (Array.isArray(locations)) {
      for (const entry of locations) {
        const raw = asString(asRecord(entry)?.["path"]);
        if (raw === null) continue;
        const canonical = await realpathDeep(raw, ctx.cwd, ctx.realpath);
        // Deduped, order preserved: two `locations[]` entries naming one file must not make the
        // all-must-match rule harder to satisfy than the call actually is.
        if (!paths.includes(canonical)) paths.push(canonical);
      }
    }
  }

  return {
    method: req.method,
    type,
    kind: toolCall === null ? null : asString(toolCall["kind"]),
    paths,
    // F38: a `read`-classified call carried no `rawInput` at all, so a command is read from the
    // COMMAND arm and from nowhere else. Reaching into a tool call for one would be inventing a
    // string to match on.
    command: type === "command" && subject !== null ? asString(subject["command"]) : null,
    title: req.title,
    agentId: ctx.agentId,
    cwd: ctx.cwd,
  };
}
