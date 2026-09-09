#!/usr/bin/env node
// Fixture agent: elicit-oneof — ONE question, `oneOf[].const` plus the paired `_custom` property,
// mirrored as an `AskUserQuestion` tool call. Transcript `12`'s shape exactly (F30, F32).
//
// The answer a client is expected to give is one of the OFFERED consts, which must reach the wire
// as `question_0` and never as `question_0_custom`.
//
// Owned by M2-A-WP-I.
import { elicitAgent } from "./elicit-support.mjs";

elicitAgent({
  name: "elicit-oneof",
  message: "What should the new file be named?",
  questions: [
    { id: "question_0", title: "File name", choices: ["notes.md", "README.md", "main.py"] },
  ],
});
