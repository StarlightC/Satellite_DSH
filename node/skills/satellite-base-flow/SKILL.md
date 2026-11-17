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

These six nodes plus optional `version-control` form an available directory of
seven, not a mandatory pipeline. All have base runners. `version-control` has a
same-name dedicated role and `satellite-version-control` method, without tiers;
select it only for a concrete explicit user request, never as the default tail of
another intent. It supports local status/diff/log/stage/commit only, with fresh
host approval for writes and no remote operation. Version text edits still belong
to `implement`, which does not commit. Missing services are a gap, not completion.

### Implement handback to the parent

An `implement` result may carry `parentAction` with `status: published`. Only then
may the parent execute that one action: call exactly the given `tool` with exactly
the given `arguments`, once. Run `list_plugins`/`list_bundles` first; a list
handback never authorizes an install, a change, or wider parameters. Do not widen,
reorder-away, add, or reuse arguments, do not call `satellite_parent_request`
yourself, and do not manufacture facts, decisions, text, or resume tokens to obtain
a ticket. The ticket and its audit fields are data, not approval or a bearer token;
the host approval for that tool still runs independently and may refuse. A
`suspended`, `expired`, or `dropped` handback publishes nothing. Every other tool
keeps the normal closed-set coordinator restriction.

The order is not fixed for every task. Read
[the task intents and diagnostics reference](references/task-intents.md) when you
need the node order for a specific intent (feature, bug-fix, refactor,
test-coverage, ui-adjustment, project-health, current-change-analysis,
review-and-plan, commit / optional version-control, release-preparation), when the right specialist method is
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
adds its own mapping. The reserved `version-control` node never accepts `tier`.
Keep whole-task execution difficulty separate from the node's
optional `tier`; carry the reasons and failed-attempt history in the existing bounded
task packet. This is an Agent judgment/reporting method, not an automatic scoring or
retry engine.

## Rules that do not change per project

1. Establish sufficient bounded context, reusing current evidence when its inputs
   are unchanged; do not repeat investigation merely to visit a node. Before any
   side effect, check tool/service/route/permission availability without side effects.
2. Real changes to the agreed baseline need the user's decision. New evidence
   does not silently widen the goal.
3. Select the nodes and checks the task actually needs. A simple version, wording,
   or value change with sufficient context can use implementation plus targeted
   checks, without mechanical context → solution → review → full validation. A
   dependency or script change is not a pure version edit. Agreed necessary review,
   mandatory slots, and host approval remain obligations: avoiding duplicate
   execution does not remove them. One unit at a time; inspect the real diff and
   retain required review/verification. Missing evidence is not a pass.
4. Keep failed evidence. Do not restart a rejected approach under a new name.
5. A finished agent run is a runtime fact, not business acceptance. Say what is
   verified, what is not, and where the limit comes from.
6. Environment or permission blocks are reported as blocks; they are not
   solved by asking a more expensive model.
7. Keep a minimum sufficient verification budget. A new test or check names the
   real production path or reproduction it exercises and the unique regression it
   protects; combining existing paths is not a default reason, and coverage a
   higher-level check already holds is not copied. Do not reshape production code
   for tests or fakes, and do not treat test count or line count as a quota. Check a
   doubt's reachability and actual impact before adding cases; unknown stays unknown.
   After a fix, run the affected set and reuse unchanged evidence; the final round is
   one necessary run, not a full suite per review. Stop at the stated stop condition.
   Necessary safety boundaries stay, and a light documentation edit needs no strongly
   coupled string test.

## Proposing and relaying options

The parent's own proposals follow
[the option scoring reference](../satellite-solution/references/option-scoring.md),
not only proposals from a `solution` child: for each actually evaluated option,
score `N/D/C/E`, `T` and `U`, state the basis, gap and verdict, and apply the hard
gates before the total. Pass the user's original goal and authorization boundary to
the child; do not upgrade them.

Relaying does not add evidence. Keep a conditional candidate conditional, a
suggestion a suggestion, and a recommendation a recommendation; a suggestion or a
plan is not the user's consent. A score or threshold is not a user decision or host
approval. Re-score only on new evidence, not by switching model, role, or wording.
When a decision is pending, stop with the existing `acceptance.required` fact and
resume with its token; do not add a new mandatory extension or claim program
enforcement.

An already authorized, pure numeric/text/value edit with no technical choice may use
one line and skip an extra `solution` pass; that lightweight exception does not
cover technical, permission, dependency, script, schema, or public-contract changes.

## Reading results

Hand back short decisions with exact locations. Read long content at its real
source instead of restating it. There is no fixed report format, but a proposal or a
relayed option still carries the minimum option-scoring content; do not pad a simple
answer into a long template.
