#!/usr/bin/env node
// Fixture agent: elicit-multi — TWO questions in one form.
//
// The corpus has none: multi-question forms are `unverified` on BOTH real agents (§11.9), so this
// fixture is the only place the shape runs at all — one property per questionId on the wire, and
// two `_custom` slots that must both stay empty when both answers are offered values.
//
// Owned by M2-A-WP-I.
import { elicitAgent } from "./elicit-support.mjs";

elicitAgent({
  name: "elicit-multi",
  message: "Two things, please.",
  questions: [
    { id: "question_0", title: "File name", choices: ["notes.md", "README.md"] },
    { id: "question_1", title: "Language", choices: ["python", "javascript"] },
  ],
});
