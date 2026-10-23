---
name: satellite-implementation
description: Implementation in reviewable units for Satellite DSH: change only the agreed baseline, keep the diff reviewable, run the necessary compile check, and hand the real diff to review.
whenToUse: Use for the `implement` node, and whenever an agreed unit has to be changed in code or configuration — including rework after review findings.
---

# Implementation in units

Change what was agreed, in pieces small enough to review. This node edits files;
it does not commit, publish, verify, or widen the goal.

## Before editing

Restate the unit in one short block:

- what changes, and why this is the agreed baseline;
- the files or areas in scope, and what is explicitly out of scope;
- the check that will show the unit works (the command or observation);
- what decision is still missing, if any — if a decision is missing, stop here.

A unit whose scope cannot be written in one sentence is too large; split it.

When it is hard to bound the unit, when a review finding has to become a rework unit,
or when you need the line between "checked here" and full verification, read
[the unit boundaries reference](references/unit-boundaries.md).

## While editing

- Make the smallest change that satisfies the unit.
- Reuse existing helpers, conventions, and configuration instead of adding parallel
  ones.
- Do not rewrite unrelated code, reformat neighbouring files, or "improve" things
  the unit did not ask for.
- Keep the diff reviewable: one unit at a time, and no unrelated edits mixed in.
- Do not add tests that only assert the implementation you just wrote; add the
  check the unit actually needs.
- Never commit, tag, push, publish, or touch credentials and secrets.

If the change turns out to need a wider goal, a new permission, or a decision that
was never approved, stop and hand back the decision instead of taking it.

## Reuse index maintenance

After a successful implementation, if an index already exists and this unit changed
an indexed reusable surface, request the available index maintenance tool with only
those changed or deleted source paths. Keep semantic adjustments limited to entries
whose meaning this unit actually established. The tool still requires host approval;
a task packet or a role name is not authorization. Never initialize a baseline,
rebuild unrelated files, edit generated index data, or rewrite user overrides here.
If the tool or baseline is unavailable, hand the exact changed paths and maintenance
gap back to the parent; do not claim the index was updated. This method alone does
not imply that the optional maintenance tool is mounted or has run.

## Bounded correction and tier handoff

At the assigned tier, stop after three failed implementation attempts on the same
unit (including internal corrections and earlier failures at this same tier), or
earlier when no evidence-backed correction is worth trying. A higher tier has its
own bounded budget; earlier tiers' failures remain evidence, not spent attempts
against the new tier. One attempt is a coherent hypothesis
or change shown by evidence not to meet its target; several diagnostics from one
check count once. This is a reasoning/reporting budget, not a tool-call counter.
Do not run extra checks to count attempts or take over full validation.

Report each failed hypothesis and its evidence, the failed count/limit, remaining
blocker, partial edits and the smallest useful handoff. If history or evidence is
missing, state that gap instead of inventing a count or claiming a fresh budget.
New child calls or cosmetic subdivisions do not reset the same unit's history.
Recommend Standard from Light, Senior or a relevant specialist from Standard, and
specialist/user direction from exhausted Senior. The parent chooses reassignment;
do not delegate upward yourself. A stronger role does not authorize a wider scope.
Keep external environment/permission blockers separate from implementation failures.

## After editing

Run the necessary compile, type, or lint check for the area you touched, and report
its real result. Full verification belongs to `validate`; do not present a partial
check as verification.

Keep failed evidence: if a check failed and you fixed it, say both.

## Handing back

Report, short and checkable:

- what changed, with exact file locations;
- what is unfinished or deliberately left out;
- the check you ran and its result;
- what the reviewer should read first — the real diff, not a summary of it.

Environment or permission blocks are reported as blocks. They are not solved by a
more expensive model, and they are not a reason to claim the unit is done.
