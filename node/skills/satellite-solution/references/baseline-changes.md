# Baseline changes and configuration migrations

Read this when the plan may change the agreed baseline, or when it touches shipped
configuration, schema, or defaults. It extends [the solution method](../SKILL.md).

## What counts as a baseline change

The baseline is what was agreed: goal, scope, contracts, and the accepted limits.
Each of these needs the user's decision, not a technical default:

- widening or narrowing the goal, or changing who the change is for;
- changing a public contract, file format, or configuration shape that others
  already depend on;
- dropping a capability, a platform, or an existing guarantee;
- accepting a known-broken path instead of fixing it.

New evidence does not grant that decision. State what changed in the facts, then
stop and ask.

## Choose the smallest option that satisfies the goal

For each real option, write: what it changes, which consumers and tests it touches,
what it reuses, its cost, and how reversible it is. Prefer reuse of an existing
helper, convention, or configuration over a parallel mechanism. An option you cannot
judge is reported as unjudged, not recommended with invented confidence.

## Configuration and schema migrations

When a shipped shape changes:

- give the new shape one home, and migrate callers rather than supporting two
  representations of the same choice;
- keep defaults in code: a profile should record a user choice, not a snapshot of
  today's default;
- if the effective default for a layer cannot be read, say so and refuse the edit
  instead of guessing a value;
- remember that a later configuration layer replaces a whole row's config rather
  than deep-merging it; name what must stay intact;
- state whether existing users migrate automatically, keep working unchanged, or
  must act, and what happens when they do not.

## Decision ownership

Say which decisions are yours as technical defaults (file layout, internal names,
test fixture shape) and which belong to someone else (the user's goal, an approval,
a project convention). Only the second kind stops the flow. Never answer the user's
decision by implementing the option you prefer, by escalating to a more expensive
model, or by quietly narrowing the goal.
