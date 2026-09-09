#!/usr/bin/env node
// Fixture agent: elicit-custom — the same one question, expecting an answer OUTSIDE `oneOf`.
//
// F30's routing rule from the other side: a value the schema does not offer belongs in
// `question_0_custom` and in NOTHING else. Our recorder filled both and the agent used the custom
// one, creating `omni-choice.txt` instead of the selected `notes.md`; this fixture is how that is
// asserted on the frames rather than on the SDK's own view.
//
// Owned by M2-A-WP-I.
import { elicitAgent } from "./elicit-support.mjs";

elicitAgent({
  name: "elicit-custom",
  message: "What should the new file be named?",
  questions: [{ id: "question_0", title: "File name", choices: ["notes.md", "README.md"] }],
});
