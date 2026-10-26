---
name: satellite-base-flow
description: Public baseline workflow for Satellite DSH: bounded investigation, a plan with the decisions it needs, implementation in units, independent review, verification, and acceptance.
whenToUse: Use at the start of any non-trivial change, and whenever you need the public node order and its stop conditions. Domain components extend the nodes through public slots instead of replacing the flow.
---

# Public base flow — parent orchestration

This skill belongs to the parent coordinating the work, not a node execution
agent. The parent selects bounded nodes, supplies prior evidence, handles pauses
and user decisions, and decides the next node. A delegated executor completes only
its assigned node and returns; it does not call this flow recursively. Validation
executors use `satellite-validation`, not this orchestration skill.

The main session coordinates: delegate concrete investigation, file changes,
execution, review, and validation through `satellite_node`, and resume paused
nodes with their token. Do not substitute `subagent`, `subagent_fork`,
`workflow`, or generic `send_message`.

The base flow is one entry with stable nodes. Before and after each node, the
`satellite_node` tool checks the public slots and runs the extensions that
apply. You never call a slot yourself, and no argument skips the checks.

## Nodes

- `context` — establish the bounded facts the task needs.
- `solution` — weigh options and present the decisions the task requires.
- `implement` — make the change in reviewable units.
- `review` — independently check the actual change.
- `validate` — run the checks the project actually has.
- `signoff` — state acceptance, evidence, and remaining limits.

All six nodes — `context`, `solution`, `implement`, `validate`, `review` and
`signoff` — have base runners in this build. Calling a node without a base
runner returns a gap naming what is missing; do not fake its completion.

The order is not fixed for every task. Read
[the task intents and diagnostics reference](references/task-intents.md) when you
need the node order for a specific intent (feature, bug-fix, refactor,
test-coverage, ui-adjustment, project-health, current-change-analysis,
review-and-plan, commit, release-preparation), when the right specialist method is
not obvious, when a report has to be graded (blocked / needs a decision /
suggestion / unverified), when a component looks unavailable, or when configuring a
component whose shape changed. Read it for those decisions only; do not restate its
tables in the task packet.

## Difficulty and reassignment

Before choosing a solution, implementation, or review role, or when new evidence
changes risk or a blocker repeats, read
[the difficulty and escalation method](references/difficulty-and-escalation.md).
Only `solution`, `implement`, and `review` have default role tiers;
`context`, `validate`, and `signoff` are called without `tier` unless a deployment
adds its own mapping. Keep whole-task execution difficulty separate from the node's
optional `tier`; carry the reasons and failed-attempt history in the existing bounded
task packet. This is an Agent judgment/reporting method, not an automatic scoring or
retry engine.

## Rules that do not change per project

1. Bounded investigation first: name the scope, the questions, and the stop
   condition before reading widely.
2. Real changes to the agreed baseline need the user's decision. New evidence
   does not silently widen the goal.
3. One unit at a time: implement, review the real diff, then verify. Missing
   evidence is not a pass.
4. Keep failed evidence. Do not restart a rejected approach under a new name.
5. A finished agent run is a runtime fact, not business acceptance. Say what is
   verified, what is not, and where the limit comes from.
6. Environment or permission blocks are reported as blocks; they are not
   solved by asking a more expensive model.

## Reading results

Hand back short decisions with exact locations. Read long content at its real
source instead of restating it; do not invent a report format.
