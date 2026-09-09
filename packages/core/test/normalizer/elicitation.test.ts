import { describe, expect, it } from "vitest";
import { OmniError, type ElicitationField } from "@omni-acp/protocol";
import { loadTranscript } from "@omni-acp/testkit";
import { buildElicitationContent, mapElicitation } from "../../src/normalizer/map/elicitation.js";

/**
 * `mapElicitation` / `buildElicitationContent` against transcripts `12` and `13` — the two
 * recorded `elicitation/create` exchanges, which are the only ground truth either function has.
 *
 * Every input below is READ OUT OF THE TRANSCRIPT rather than retyped, because F30 is exactly the
 * kind of fact a hand-written fixture gets subtly wrong: our own recorder filled BOTH properties
 * of the one question group and the agent used the custom one, creating `omni-choice.txt` instead
 * of the selected `notes.md`.
 *
 * Owned by M2-A-WP-I.
 */

/** The `elicitation/create` params, verbatim, from one recorded transcript. */
function elicitationParams(name: string): Record<string, unknown> {
  for (const line of loadTranscript(name)) {
    if (line.dir !== "agent->client") continue;
    const msg = line.msg as { method?: unknown; params?: unknown } | undefined;
    if (msg?.method !== "elicitation/create") continue;
    return msg.params as Record<string, unknown>;
  }
  throw new Error(`no elicitation/create in transcript ${name}`);
}

const ACCEPT = "12-elicitation-declared-accept";
const DECLINE = "13-elicitation-declared-decline";

const fieldOf = (fields: readonly ElicitationField[], id: string): ElicitationField => {
  const f = fields.find((x) => x.id === id);
  if (f === undefined) throw new Error(`no field ${id}`);
  return f;
};

describe("mapElicitation (§5.8.9, F29/F30)", () => {
  it("reads the FLAT scope fields — sessionId and toolCallId sit in params, not under `scope` (F29)", () => {
    const params = elicitationParams(ACCEPT);
    // The transcript itself: no `scope` key anywhere, and the two scope fields at the top level.
    expect(params["scope"]).toBeUndefined();
    const mapped = mapElicitation(params);
    expect(mapped.sessionId).toBe("ccc2fe5a-4cad-4aab-b9fd-d3ca8fbd98d5");
    expect(mapped.toolCallId).toBe("toolu_01SakPc6seZWxisAvLoFxEBv");
    expect(mapped.mode).toBe("form");
    expect(mapped.message).toBe("What should the new file be named?");
  });

  it("folds oneOf[].const AND enum into `options`, in wire order (F30)", () => {
    const mapped = mapElicitation(elicitationParams(ACCEPT));
    const q0 = fieldOf(mapped.fields, "question_0");
    // claude-acp sends `oneOf`, NOT `enum`. A reader that knows only `enum` sees this as
    // unconstrained free text and routes every answer to the custom slot — F30 from the other
    // side.
    expect(q0.options.map((o) => o.value)).toEqual([
      "notes.md",
      "README.md",
      "main.py",
      "index.js",
    ]);
    expect(q0.options[0]).toEqual({
      value: "notes.md",
      title: "notes.md",
      description: "A Markdown scratch/notes file in /tmp/omni-m2-a6CzN6",
    });
    expect(q0.type).toBe("string");
    expect(q0.title).toBe("File name");

    // The `enum` half of the union, which no recorded agent sends but the v1 schema's own note
    // says single-select may use.
    const withEnum = mapElicitation({
      mode: "form",
      sessionId: "s",
      message: "m",
      requestedSchema: {
        type: "object",
        properties: { q: { type: "string", enum: ["a", "b"] } },
      },
    });
    expect(fieldOf(withEnum.fields, "q").options.map((o) => o.value)).toEqual(["a", "b"]);
  });

  it("pairs question_0_custom to question_0 through _meta._askUserQuestionCustomAnswer (F30)", () => {
    const mapped = mapElicitation(elicitationParams(ACCEPT));
    // ONE question, TWO schema properties, ONE field. A UI that rendered the custom slot as its
    // own question is a UI that can send both halves of the group.
    expect(mapped.fields.map((f) => f.id)).toEqual(["question_0"]);
    expect(fieldOf(mapped.fields, "question_0").customField).toBe("question_0_custom");
    expect(mapped.unmodelled).toEqual([]);
  });

  it("reports no `required` array as `required: false` on every field (F29)", () => {
    const params = elicitationParams(ACCEPT);
    expect((params["requestedSchema"] as Record<string, unknown>)["required"]).toBeUndefined();
    expect(mapElicitation(params).fields.every((f) => !f.required)).toBe(true);
  });

  it("maps transcript 13 — the DECLINE recording — to the same shape", () => {
    const mapped = mapElicitation(elicitationParams(DECLINE));
    expect(mapped.sessionId).toBe("7c94c1bc-4212-48f2-bea9-455e52ff2ba7");
    expect(mapped.toolCallId).toBe("toolu_014v53L6RfcLLvY1vLPTxvLo");
    expect(mapped.fields.map((f) => f.id)).toEqual(["question_0"]);
    expect(fieldOf(mapped.fields, "question_0").options.map((o) => o.value)).toEqual([
      "notes.md",
      "README.md",
      "main.py",
    ]);
    expect(mapped.unmodelled).toEqual([]);
  });

  it("is idempotent: mapping a mapped request twice is deep-equal to mapping it once", () => {
    for (const name of [ACCEPT, DECLINE]) {
      const params = elicitationParams(name);
      const once = mapElicitation(params);
      const twice = mapElicitation(once.raw);
      expect(twice).toEqual(once);
      // BY IDENTITY (review R11): a second application keeps the FIRST one's params, which is
      // what makes the audit `acp.interaction.raw` publishes the AGENT's bytes and not ours.
      expect(twice.raw).toBe(params);
    }
  });

  it("keeps `raw` by identity and never reshapes it (§7.5)", () => {
    const params = elicitationParams(ACCEPT);
    expect(mapElicitation(params).raw).toBe(params);
  });

  it("rejects a nested `scope` with a NAMED error rather than silently mis-parsing it", () => {
    const params = elicitationParams(ACCEPT);
    const nested = {
      mode: params["mode"],
      message: params["message"],
      requestedSchema: params["requestedSchema"],
      scope: { sessionId: params["sessionId"], toolCallId: params["toolCallId"] },
    };
    let thrown: unknown;
    try {
      mapElicitation(nested);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OmniError);
    expect((thrown as OmniError).code).toBe("bad_request");
    // The name is in the message: a mis-parse here yields an interaction with no scope at all,
    // and "sessionId: ''" is not a diagnosis anybody can act on.
    expect((thrown as OmniError).message).toContain("scope");
    expect((thrown as OmniError).message).toContain("F29");
  });

  it("an unparseable schema yields fields: [] with every property in `unmodelled`", () => {
    const mapped = mapElicitation({
      mode: "form",
      sessionId: "s",
      message: "m",
      requestedSchema: { type: "object", properties: { a: { oneOf: [] }, b: 7 } },
    });
    // §19.4: better than a form that lies about its own shape — `answer` is impossible and
    // `deny` / `cancel` are still possible.
    expect(mapped.fields).toEqual([]);
    expect([...mapped.unmodelled].sort()).toEqual(["a", "b"]);
  });

  it("is TOTAL over junk: no params, no schema, wrong types — never a throw", () => {
    for (const junk of [undefined, null, 7, "x", [], { requestedSchema: 3 }]) {
      const mapped = mapElicitation(junk);
      expect(mapped.fields).toEqual([]);
      expect(mapped.sessionId).toBe("");
      expect(mapped.message).toBe("");
      expect(mapped.mode).toBe("form");
    }
  });

  it("reports a custom slot whose owner is not a modelled question", () => {
    const mapped = mapElicitation({
      mode: "form",
      sessionId: "s",
      message: "m",
      requestedSchema: {
        type: "object",
        properties: {
          orphan_custom: {
            type: "string",
            _meta: { _askUserQuestionCustomAnswer: { questionId: "gone", isCustomAnswer: true } },
          },
        },
      },
    });
    expect(mapped.fields).toEqual([]);
    expect(mapped.unmodelled).toEqual(["orphan_custom"]);
  });
});

describe("buildElicitationContent — EXACTLY ONE property per questionId (F30, §19.4)", () => {
  const fields = (): readonly ElicitationField[] =>
    mapElicitation(elicitationParams(ACCEPT)).fields;

  it("routes an offered value to the question's own property, and nothing else", () => {
    expect(buildElicitationContent(fields(), { question_0: "notes.md" })).toEqual({
      question_0: "notes.md",
    });
  });

  it("routes a value outside oneOf to the paired _custom property, and nothing else", () => {
    expect(buildElicitationContent(fields(), { question_0: "omni-choice.txt" })).toEqual({
      question_0_custom: "omni-choice.txt",
    });
  });

  /**
   * The regression is NAMED after the file transcript `12` wrongly created.
   *
   * Our recorder answered `{question_0:"notes.md", question_0_custom:"omni-choice.txt"}` and the
   * agent used the CUSTOM one: it created `omni-choice.txt` and not the selected `notes.md`. The
   * `_meta` marker silently wins, so a client that fills every declared property overrides the
   * user's actual selection — and the daemon must refuse rather than pick for them.
   */
  it("refuses to create omni-choice.txt: answering both members of a group is bad_request", () => {
    let thrown: unknown;
    try {
      buildElicitationContent(fields(), {
        question_0: "notes.md",
        question_0_custom: "omni-choice.txt",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OmniError);
    expect((thrown as OmniError).code).toBe("bad_request");
    expect((thrown as OmniError).message).toContain("question_0_custom");
    expect((thrown as OmniError).message).toContain("question_0");
  });

  it("names the unknown question in the 400 rather than dropping it silently", () => {
    let thrown: unknown;
    try {
      buildElicitationContent(fields(), { question_9: "x" });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as OmniError).code).toBe("bad_request");
    expect((thrown as OmniError).message).toContain("question_9");
  });

  it("refuses a value outside oneOf when the question has no custom slot", () => {
    const noCustom = mapElicitation({
      mode: "form",
      sessionId: "s",
      message: "m",
      requestedSchema: {
        type: "object",
        properties: { q: { type: "string", oneOf: [{ const: "a" }, { const: "b" }] } },
      },
    }).fields;
    expect(buildElicitationContent(noCustom, { q: "a" })).toEqual({ q: "a" });
    expect(() => buildElicitationContent(noCustom, { q: "z" })).toThrow(/not one of the values/);
  });

  it("checks the declared JSON type before the routing rule", () => {
    const typed = mapElicitation({
      mode: "form",
      sessionId: "s",
      message: "m",
      requestedSchema: {
        type: "object",
        properties: {
          n: { type: "integer" },
          b: { type: "boolean" },
          a: { type: "array" },
        },
      },
    }).fields;
    expect(buildElicitationContent(typed, { n: 3, b: true, a: ["x"] })).toEqual({
      n: 3,
      b: true,
      a: ["x"],
    });
    expect(() => buildElicitationContent(typed, { n: 1.5 })).toThrow(/expects a integer/);
    expect(() => buildElicitationContent(typed, { b: "yes" })).toThrow(/expects a boolean/);
    expect(() => buildElicitationContent(typed, { a: "x" })).toThrow(/expects a array/);
  });

  it("refuses an unanswered required question", () => {
    const required = mapElicitation({
      mode: "form",
      sessionId: "s",
      message: "m",
      requestedSchema: {
        type: "object",
        required: ["q"],
        properties: { q: { type: "string" } },
      },
    }).fields;
    expect(required[0]?.required).toBe(true);
    expect(() => buildElicitationContent(required, {})).toThrow(/required/);
    expect(buildElicitationContent(required, { q: "x" })).toEqual({ q: "x" });
  });

  it("answers a MULTI-question form one property per question (unverified on both agents)", () => {
    // The corpus has no multi-question form; §11.9 lists it as schema-only, so the shape is
    // exercised here and the descriptor calls it `unverified` rather than claiming it works.
    const multi = mapElicitation({
      mode: "form",
      sessionId: "s",
      message: "m",
      requestedSchema: {
        type: "object",
        properties: {
          question_0: { type: "string", oneOf: [{ const: "a" }] },
          question_0_custom: {
            type: "string",
            _meta: {
              _askUserQuestionCustomAnswer: { questionId: "question_0", isCustomAnswer: true },
            },
          },
          question_1: { type: "string", oneOf: [{ const: "y" }] },
          question_1_custom: {
            type: "string",
            _meta: {
              _askUserQuestionCustomAnswer: { questionId: "question_1", isCustomAnswer: true },
            },
          },
        },
      },
    }).fields;
    expect(buildElicitationContent(multi, { question_0: "a", question_1: "free text" })).toEqual({
      question_0: "a",
      question_1_custom: "free text",
    });
  });

  it("is impossible to answer a form that mapped no fields — deny and cancel stay possible", () => {
    expect(() => buildElicitationContent([], { anything: "x" })).toThrow(/unknown question/);
    expect(buildElicitationContent([], {})).toEqual({});
  });
});
