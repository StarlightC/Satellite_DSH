---
name: satellite-solution
description: Solution shaping for Satellite DSH: turn bounded facts into options, name the decisions the task needs, and stop before implementation.
whenToUse: Use for the `solution` node, and whenever a task needs a reviewable plan rather than an immediate change — including when several approaches are plausible or when the goal itself needs a decision.
---

# Solution shaping

Turn facts into a plan someone else can review. This node ends at decisions: it
does not implement, and it does not widen the goal.

## Start from the facts

Restate the bounded facts the plan rests on, each with its exact location, and
say which of them came from `context` and which you checked yourself. A plan built
on unstated facts cannot be reviewed.

## Reuse evidence

When the task involves an existing shared surface, consume the bounded reuse query
from investigation (or query the available index tool with task-specific terms).
Check the selected candidates against their source before deciding reuse versus a
new implementation. An index is candidate evidence, not an applicability verdict.
Missing, invalid, stale, or unavailable indexes require bounded ordinary search;
never initialize or refresh an index in this read-only node. Explicit-file coverage
is partial: no matches does not establish that the entire project lacks a reusable
surface. Do not load the complete index or override files into model context.

## Weigh options

For each option that is genuinely on the table:

- what it changes, and which consumers or existing tests it touches;
- what it reuses (existing helpers, conventions, configuration) instead of adding;
- its cost and how reversible it is;
- the evidence for the claim — "this should work" is not evidence.

Prefer the smallest change that satisfies the goal. Reject an option you cannot
judge instead of presenting invented confidence.

## Name the decisions

List every decision the task actually requires, one line each:

- the choice, the tradeoff, and what you would take by default;
- who the choice belongs to when it is not yours (the user's goal, an approval, a
  project convention);
- the consequence of deciding late.

A decision that only the user can make stops the flow here. Do not answer it by
implementation, by a more expensive model, or by silently narrowing the goal.

When the plan may change the agreed baseline, or touches shipped configuration,
schema, or defaults, read
[the baseline changes and migrations reference](references/baseline-changes.md) for
what needs a decision, how to keep a migration reversible, and how to separate your
technical defaults from someone else's choice.

## Handing back

Report: the recommended option, the decisions needed, the files or areas the work
would touch, and the risks and limits you could not resolve. Keep it short enough
to review, and point at real sources for anything long.

New evidence does not silently widen the agreed baseline: if the facts changed the
goal, say so and stop for a decision. Do not edit files, run mutations, or start
implementing in this node.
