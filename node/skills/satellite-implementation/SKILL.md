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

## Role tier responsibilities

The assigned tier changes the depth and scope of the same implementation method; it
does not grant extra tools, sandbox breadth, or approval. Every implementation tier
keeps the same permission posture and parent-imposed limits.

| Tier | Responsibility |
| --- | --- |
| light | Implement a boundary-clear, local, low-ambiguity unit and state the local impact. Keep the safety and compatibility checks the unit actually needs; if the scope becomes cross-cutting or unresolved, stop and hand back. |
| standard | Handle conventional implementation and check the complete impact against the real consumers, tests, and configuration. |
| senior | Handle cross-module coupling, complex constraints, or a unit with existing failure evidence. Recheck that evidence, avoid repeating rejected methods, and return the unresolved gap rather than looping. |
| critical | Re-examine the implementation's core assumptions and construct counterexamples. Pursue a stubborn problem in depth without treating high risk or total irreversibility as a requirement. With sufficient evidence, a Critical attempt may pass; when it remains unsolved, stop and request a decision. |

## While editing

- Make the smallest change that satisfies the unit.
- Reuse existing helpers, conventions, and configuration instead of adding parallel
  ones.
- Do not rewrite unrelated code, reformat neighbouring files, or "improve" things
  the unit did not ask for.
- Keep the diff reviewable: one unit at a time, and no unrelated edits mixed in.
- Do not add tests that only assert the implementation you just wrote; add the
  check the unit actually needs.
- Before adding a gate, fallback, or second check, give the real entry chain,
  trigger condition, existing guarantee, and reachability evidence. Verify an
  evidence gap first; a stand-in that can construct the state or a theoretical
  possibility is not a reason to add one, and do not repeat the same rule in
  several places.
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

At the assigned implementation tier, stop after three failed attempts on the same
unit (including internal corrections and earlier failures at this same tier), or
earlier when no evidence-backed correction is worth trying. This three-attempt budget
belongs only to implementation; solution and review do not inherit it. A higher
implementation tier has its own bounded budget; earlier tiers' failures remain
history and evidence, not spent attempts against the new tier. One attempt is a
coherent hypothesis or change shown by evidence not to meet its target; several
diagnostics from one check count once. This is a reasoning/reporting budget, not a
tool-call counter. Do not run extra checks to count attempts or take over full
validation.

Report each failed hypothesis and its evidence, the failed count/limit, remaining
blocker, partial edits and the smallest useful handoff. If history or evidence is
missing, state that gap instead of inventing a count or claiming a fresh budget.
New child calls or cosmetic subdivisions do not reset the same unit's history.
Recommend Standard from Light, Senior from Standard, and Critical or a relevant
specialist from Senior when the remaining evidence supports that depth. An exhausted
Critical unit stops with the unresolved gap and requests a decision; do not start
another Critical loop or delegate upward yourself. The parent chooses reassignment;
a stronger role does not authorize a wider scope. Keep external
environment/permission/credential blockers separate from implementation failures;
they do not justify a higher tier.

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
