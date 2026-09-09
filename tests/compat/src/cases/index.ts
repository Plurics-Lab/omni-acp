import { configOptionCases } from "./config-option.js";
import { elicitationCases } from "./elicitation.js";
import { m1Cases } from "./m1.js";
import { patchCases } from "./patch.js";
import { permissionCases } from "./permission.js";
import { promptContentCases } from "./prompt-content.js";
import { watchdogCases } from "./watchdog.js";
import { webhookRunCases } from "./webhook-run.js";
import type { CompatCase } from "./support.js";

export type { CompatCase, CompatContext } from "./support.js";

/**
 * The case registry (M2-PLAN §1.4).
 *
 * Every work package's file is imported HERE, at the Land step, including the ones that are still
 * empty. That is deliberate and it is the whole reason this file is written once and then left
 * alone: a work package that had to add its own import line would have to edit the registry, and
 * six packages editing one registry is the merge conflict the split exists to prevent.
 *
 * M1's thirteen come first, unchanged, so a compat report reads in the same order it always has.
 */
export function compatCases(): readonly CompatCase[] {
  return [
    ...m1Cases(),
    ...elicitationCases(),
    ...permissionCases(),
    ...configOptionCases(),
    ...watchdogCases(),
    ...webhookRunCases(),
    ...promptContentCases(),
    ...patchCases(),
  ];
}
