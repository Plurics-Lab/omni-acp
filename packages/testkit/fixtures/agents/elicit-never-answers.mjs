#!/usr/bin/env node
// Fixture agent: elicit-never-answers — issues `elicitation/create` and waits.
//
// It is the ONLY way to test `parkTimeoutAction` (§11.9's first risk): both corpus elicitations
// were answered in ~1 ms, so nobody knows what a real agent does with a long park. This fixture
// removes the human from the loop entirely — it asks, nothing answers, and the daemon's own park
// deadline is the only thing that can end the wait.
//
// It DOES finish the turn once the daemon's answer arrives, because `parkTimeoutAction` puts a
// real answer on the wire (§19.8) and a fixture that hung afterwards would hide whether it landed.
//
// Owned by M2-A-WP-I.
import { elicitAgent } from "./elicit-support.mjs";

elicitAgent({
  name: "elicit-never-answers",
  message: "This one is never answered by a human.",
  questions: [{ id: "question_0", title: "File name", choices: ["notes.md", "README.md"] }],
});
