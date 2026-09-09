import { OmniError } from "@omni-acp/protocol";
import type { ElicitationField, MappedElicitationRequest } from "@omni-acp/protocol";

/**
 * `elicitation/create` params → a shape a route and a UI can address. PURE, TOTAL, IDEMPOTENT.
 *
 * Three recorded facts decide every line of it, and none of them is guessable from the v1 schema:
 *
 *  - **F29, the scope is FLAT.** `sessionId` and `toolCallId` sit directly in `params`, not under
 *    a `scope` object. A fixture that nests them is REJECTED with a named error rather than
 *    silently mis-parsed, because a mis-parse here produces an interaction with no scope at all.
 *  - **F30, `oneOf[].const` and `enum` are both real.** claude-acp sends `oneOf`; a reader that
 *    knows only `enum` sees every question as unconstrained free text.
 *  - **F30 again, the `_custom` pairing.** `_meta._askUserQuestionCustomAnswer.{questionId,
 *    isCustomAnswer}` is what marks `question_0_custom` as the free-text twin of `question_0`.
 *    Filling BOTH made the agent use the custom value and create `omni-choice.txt` instead of
 *    `notes.md`. That file name is the regression test's name.
 *
 * A schema this cannot understand yields `fields: []` with every property in `unmodelled`, which
 * makes `answer` impossible and `deny`/`cancel` still possible — instead of a form that lies
 * about itself.
 *
 * NOTE for the `no-elicitation-schema-parse` guard (§19.3, §27.4): there is no schema library and
 * no `.parse(` anywhere on this path, and there must never be one. A schema parse would strip
 * `_meta._askUserQuestionCustomAnswer` — the single field that decides which of two properties
 * the agent actually reads — and the flat scope with it. Everything below is hand-narrowed.
 *
 * Owned by M2-A-WP-I.
 */
export function mapElicitation(params: unknown): MappedElicitationRequest {
  const p = asRecord(params);

  // F29, asserted rather than tolerated. A `scope` object is the ONE shape a reader who trusted
  // the v1 type would produce, and it maps to an interaction with no session and no tool call at
  // all — so it is a named error, not a silent `sessionId: ""`.
  const scope = p["scope"];
  if (typeof scope === "object" && scope !== null) {
    throw new OmniError(
      "bad_request",
      "elicitation/create params carry a nested `scope`; F29 says the scope fields are FLAT " +
        "(sessionId and toolCallId sit directly in params)",
      { detail: { keys: Object.keys(asRecord(scope)) } },
    );
  }

  const schema = asRecord(p["requestedSchema"]);
  const properties = asRecord(schema["properties"]);
  const required = new Set(stringsOf(schema["required"]));

  // Pass 1: which properties are somebody else's custom slot, and whose. Two passes rather than
  // one, because the marker lives on the CUSTOM property and names the property it belongs to,
  // which may not have been visited yet (`question_0_custom` before `question_0` is legal JSON).
  const customOf = new Map<string, string>(); // questionId -> custom property name
  const isCustomFor = new Map<string, string>(); // custom property name -> questionId
  for (const [name, value] of Object.entries(properties)) {
    const owner = customAnswerOwner(value);
    if (owner === null) continue;
    isCustomFor.set(name, owner);
    // First marker wins, so a second `_custom` for one question is reported in `unmodelled`
    // rather than silently overwriting the pairing the agent actually meant.
    if (!customOf.has(owner)) customOf.set(owner, name);
  }

  const fields: ElicitationField[] = [];
  const unmodelled: string[] = [];
  for (const [name, value] of Object.entries(properties)) {
    // A custom slot is never a field of its own: it is answered THROUGH its question (F30), and a
    // UI that rendered it separately is a UI that can send both halves of one group.
    if (isCustomFor.has(name)) continue;
    const field = fieldOf(name, value, customOf.get(name) ?? null, required.has(name));
    if (field === null) {
      unmodelled.push(name);
      continue;
    }
    fields.push(field);
  }
  // A custom slot whose owner is not a modelled field is unanswerable, so it is reported.
  for (const [name, owner] of isCustomFor) {
    if (!fields.some((f) => f.id === owner)) unmodelled.push(name);
  }

  const meta = p["_meta"];
  return {
    // Only `mode:"form"` was ever observed (F29). An unknown spelling reads as `form` rather than
    // being invented, because `url` is a mode we deliberately never declare (§19.2) and a request
    // typed `url` that we then answered as a form would be a lie about what we did.
    mode: p["mode"] === "url" ? "url" : "form",
    sessionId: str(p["sessionId"]) ?? "",
    toolCallId: str(p["toolCallId"]),
    requestId: str(p["requestId"]),
    message: str(p["message"]) ?? "",
    fields,
    unmodelled,
    // Review R11: BY IDENTITY. `acp.interaction.raw` audits the AGENT, not our mapping (§7.5), and
    // a second application keeps the FIRST one's params — which is what makes `map(map(x))`
    // deep-equal `map(x)`, the idempotence bullet.
    raw: p,
    ...(typeof meta === "object" && meta !== null ? { _meta: meta as Record<string, unknown> } : {}),
  };
}

/**
 * The F30 rule in one function: EXACTLY ONE property per questionId reaches the wire, and WHICH
 * one is decided by whether the value is one of the schema's own consts.
 *
 * Answering both members of a question group is `bad_request` — the SDK never sends both, and the
 * daemon re-checks, because the agent reads the custom slot in preference and a client that filled
 * both would silently get the other answer.
 *
 * Owned by M2-A-WP-I.
 */
export function buildElicitationContent(
  fields: readonly ElicitationField[],
  answers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const customs = new Map<string, ElicitationField>();
  for (const f of fields) {
    if (f.customField !== null) customs.set(f.customField, f);
  }

  const out: Record<string, unknown> = {};
  const answered = new Set<string>();
  for (const [key, value] of Object.entries(answers)) {
    // F30's regression, and the reason this check comes FIRST: filling both `question_0` and
    // `question_0_custom` is exactly what created `omni-choice.txt` instead of the selected
    // `notes.md`. A client that names the custom slot is naming a wire property, not a question.
    const owner = customs.get(key);
    if (owner !== undefined) {
      throw new OmniError(
        "bad_request",
        `answers are keyed by QUESTION id: "${key}" is the custom slot of question "${owner.id}" ` +
          `— answer "${owner.id}" and the daemon decides which property reaches the wire (F30)`,
      );
    }
    const field = byId.get(key);
    if (field === undefined) {
      throw new OmniError(
        "bad_request",
        `unknown question "${key}"; this form asks ${
          fields.length === 0 ? "no answerable question" : fields.map((f) => `"${f.id}"`).join(", ")
        }`,
      );
    }
    answered.add(key);
    assertType(field, value);
    // The routing rule, and the whole of it: a value that IS one of the schema's own consts goes
    // to the question's own property; anything else is a free-text answer and goes to the custom
    // slot when there is one. A question with choices and NO custom slot cannot take a value
    // outside them at all — inventing one would send a value the agent's own schema forbids.
    if (field.options.length === 0 || isOffered(field, value)) {
      out[field.id] = value;
      continue;
    }
    if (field.customField === null) {
      throw new OmniError(
        "bad_request",
        `"${String(value)}" is not one of the values offered for question "${field.id}" ` +
          `(${field.options.map((o) => `"${o.value}"`).join(", ")}), and it offers no custom slot`,
      );
    }
    out[field.customField] = value;
  }

  for (const f of fields) {
    if (f.required && !answered.has(f.id)) {
      throw new OmniError("bad_request", `question "${f.id}" is required and was not answered`);
    }
  }
  return out;
}

// ── narrowing helpers; no schema library reaches this file (§19.3, §27.4) ────

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function stringsOf(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** `_meta._askUserQuestionCustomAnswer.{questionId, isCustomAnswer}` (F30), or null. */
function customAnswerOwner(property: unknown): string | null {
  const meta = asRecord(asRecord(property)["_meta"]);
  const marker = asRecord(meta["_askUserQuestionCustomAnswer"]);
  if (marker["isCustomAnswer"] !== true) return null;
  return str(marker["questionId"]);
}

const FIELD_TYPES = ["string", "integer", "number", "boolean", "array"] as const;
type FieldType = (typeof FIELD_TYPES)[number];

const CONSTRAINT_KEYS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
] as const;

function fieldOf(
  name: string,
  property: unknown,
  customField: string | null,
  required: boolean,
): ElicitationField | null {
  const p = asRecord(property);
  const type = p["type"];
  if (typeof type !== "string" || !(FIELD_TYPES as readonly string[]).includes(type)) return null;

  const constraints: Record<string, number> = {};
  for (const key of CONSTRAINT_KEYS) {
    const value = p[key];
    if (typeof value === "number" && Number.isFinite(value)) constraints[key] = value;
  }

  return {
    id: name,
    title: str(p["title"]),
    type: type as FieldType,
    options: optionsOf(p),
    required,
    customField,
    isCustomFor: null,
    constraints,
  };
}

/**
 * `oneOf[].const` ∪ `enum`, in WIRE ORDER (F30).
 *
 * claude-acp sends `oneOf`; the v1 schema's own note says single-select uses either, and a reader
 * that knows only `enum` sees every question as unconstrained free text — which routes every
 * answer to the custom slot and reproduces F30's bug from the other side.
 */
function optionsOf(p: Record<string, unknown>): ElicitationField["options"] {
  const out: { value: string; title: string | null; description: string | null }[] = [];
  const seen = new Set<string>();
  const oneOf = p["oneOf"];
  if (Array.isArray(oneOf)) {
    for (const entry of oneOf) {
      const e = asRecord(entry);
      const value = e["const"];
      if (typeof value !== "string" || seen.has(value)) continue;
      seen.add(value);
      out.push({ value, title: str(e["title"]), description: str(e["description"]) });
    }
  }
  for (const value of stringsOf(p["enum"])) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, title: null, description: null });
  }
  return out;
}

function isOffered(field: ElicitationField, value: unknown): boolean {
  return typeof value === "string" && field.options.some((o) => o.value === value);
}

/** The declared JSON type, checked before the routing rule — a wrong type is `400` (§19.6). */
function assertType(field: ElicitationField, value: unknown): void {
  const ok =
    field.type === "boolean"
      ? typeof value === "boolean"
      : field.type === "array"
        ? Array.isArray(value) && value.every((v) => typeof v === "string")
        : field.type === "string"
          ? typeof value === "string"
          : typeof value === "number" &&
            Number.isFinite(value) &&
            (field.type === "number" || Number.isInteger(value));
  if (ok) return;
  throw new OmniError(
    "bad_request",
    `question "${field.id}" expects a ${field.type}, received ${describe(value)}`,
  );
}

function describe(v: unknown): string {
  if (Array.isArray(v)) return "an array";
  if (v === null) return "null";
  return `a ${typeof v}`;
}
