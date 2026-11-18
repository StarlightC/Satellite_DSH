---
name: satellite-solution
description: Solution shaping for Satellite DSH: turn bounded facts into options, name the decisions the task needs, and stop before implementation.
whenToUse: Use for the `solution` node, and whenever a task needs a reviewable plan rather than an immediate change — including when several approaches are plausible or when the goal itself needs a decision.
---

# Solution shaping

Turn facts into a plan someone else can review. This node ends at decisions: it
does not implement, and it does not widen the goal.

## Start from the facts

Before shaping options, read
[the shared restriction-design principles](../satellite-base-flow/references/restriction-design.md).
For each proposed restriction, supply its risk/impact/alternative evidence and
include normal-workflow compatibility and real-scenario checks in the plan.

Restate the bounded facts the plan rests on, each with its exact location, and
say which of them came from `context` and which you checked yourself. A plan built
on unstated facts cannot be reviewed.

## Role tier responsibilities

When the `solution` node is called with a role tier, the method stays the same while
the depth and scope change. These are responsibilities, not model names or permission
levels.

| Tier | Responsibility |
| --- | --- |
| light | Shape a local, low-ambiguity option with a clear boundary. State the local facts and the impact left unexamined; do not skip a safety or compatibility check that is actually required. If the scope stops being local or ambiguous, stop and hand back. |
| standard | Solve the conventional case and check the complete impact against the real consumers, constraints, and existing checks. |
| senior | Work through cross-module coupling, complex constraints, or existing failure evidence. Recheck the prior evidence, do not repeat a rejected assumption, and return the unresolved gap rather than looping. |
| critical | Re-examine the problem's core assumptions and construct counterexamples. Pursue a stubborn issue in depth, but do not require every decision to be irreversible and do not force a negative conclusion. With sufficient evidence, a Critical plan may pass; with none, stop and request a decision. |

The tier does not grant file writes or bypass a required review. This node remains
read-only in every tier. Solution does not use implementation's three-attempt
budget: change tiers only when the evidence changes the ambiguity, coupling, or
required checks, and a Critical dead end stops for a decision rather than looping.

## Reuse evidence

When the task involves an existing shared surface, consume the bounded reuse query
from investigation (or query the available index tool with task-specific terms).
Check the selected candidates against their source before deciding reuse versus a
new implementation. An index is candidate evidence, not an applicability verdict.
Missing, invalid, stale, or unavailable indexes require bounded ordinary search;
never initialize or refresh an index in this read-only node. Explicit-file coverage
is partial: no matches does not establish that the entire project lacks a reusable
surface. Do not load the complete index or override files into model context.

## Score the options

Before presenting an option, read
[the option scoring and confidence reference](references/option-scoring.md). Every
option actually evaluated carries `N`, `D`, `C`, `E` (0–4 with anchored basis, or
explicit `U`), `T = N + D + C + E`, and a verdict. Apply the hard gates before the
total: an option that crosses the authorization boundary or changes the goal, `D <=
1`, `N <= 1`, a key unknown, or `E <= 1` cannot be recommended; `C <= 1` must be
simplified/split or shown unavoidable and never auto-passes by total; `C = U` is not
implementable. Recommend only with `N, D, C, E >= 3` and `T >= 12`; a conditional
candidate (`min(N, D, E) >= 2` and `T >= 9`) is discussion input, not approval.
`C = 2` can only stay conditional until trimmed and re-scored, so a high total with
`C = 2` is not a recommendation; `E = 1` goes to investigation. Keep `N <= E + 1`,
and require exclusivity evidence for `N = 4`.

For each option that is genuinely on the table, also state:

- what it changes, and which consumers or existing tests it touches;
- what it reuses (existing helpers, conventions, configuration) instead of adding;
- its cost and how reversible it is;
- the evidence for the claim — "this should work" is not evidence.

Consider no change, the minimal satisfaction, and a larger change; state an
infeasible category in one line instead of inventing an option. For each option,
run the counterexample check: if it were unnecessary or wrong, what would be
observable, and what did you check or leave unchecked? Do not write "only" or "must"
before the alternatives are eliminated.

Prefer the smallest change that satisfies the goal. Reject an option you cannot
judge instead of presenting invented confidence.

A score does not replace the user's decision or host approval, and a recommendation
or suggestion is not consent. Re-score only on new evidence; a different model or
role is not evidence.

An already authorized, pure numeric/text/value edit with no technical choice needs
one line saying so — no fabricated options and no extra solution pass. That
lightweight path does not cover technical, permission, dependency, script, schema,
or public-contract changes.

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
