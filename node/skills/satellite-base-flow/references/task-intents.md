# Task intents, grading, and diagnostics

Parent-side reference for [the public base flow](../SKILL.md). Read it when a task
needs its node order, when the right specialist method is not obvious, when a report
has to be graded, or when a component looks unavailable.

The orders below are recommendations, not fixed pipelines. The seven available
nodes include optional `version-control`, selected only by explicit user request. Reuse
sufficient context and select only necessary work: a simple version/wording/value
edit can use implement + targeted checks, without mechanical context → solution →
review → full validate. Dependency or script changes are not pure version edits.
Agreed necessary review, mandatory slots and approval cannot be skipped; avoiding
repeat execution is not removing an obligation. An executor completes its assigned
node and stops; it never re-orders this flow or calls a node on its own.

## The ten intents

| Intent | Node order | Required inputs / evidence | Explicit stop |
| --- | --- | --- | --- |
| feature | context → solution → implement → review → validate → signoff | goal, behaviour boundary, consumers, test entry points | pause when the plan needs a decision; do not commit by default |
| bug-fix | context → solution → implement → review → validate → signoff | reproducible evidence or a real failure observation, reachable path, regression assertion | do not start a fix from a guessed root cause |
| refactor | context → solution → implement → review → validate → signoff | the external behaviour and compatibility that must be preserved | a behaviour change returns to solution first |
| test-coverage | context → solution (only when the design is disputed) → implement → review → validate → signoff | the real coverage gap and the error each new test can catch | do not change production semantics by default |
| ui-adjustment | context → solution → implement → review → validate → signoff | the fixed source of the target state, plus the evidence the change actually needs | screenshots are not mandatory for every UI change |
| project-health | context → review → signoff | a bounded inspection surface and its evidence | read-only; never auto-fix |
| current-change-analysis | context → review | the exact diff, its baseline, and its direct consumers | read-only conclusion |
| review-and-plan | context → review → solution | the current diff and the confirmed problems in it | hand the plan back for a decision; do not continue into implementation |
| commit / version-control | optional `version-control`, only when explicitly requested by the user and available | exact repository, files/index scope and operation; fresh host approval for writes | never appended to feature or other intents by default; no remote operation |
| release-preparation | context → review/validate as needed → signoff | the release goal and the readiness matrix that applies | readiness conclusion only; no signing, upload, tag, or publish |

Per-intent notes:

- **feature** — the plan states the decision needed before implementation; a missing
  decision stops the flow instead of being answered by code.
- **bug-fix** — "it should be broken here" is not evidence. Without a failure
  observation or a reachable path, the task stays in investigation.
- **refactor** — verification compares behaviour before and after; a passing build
  alone does not establish equivalence.
- **test-coverage** — adding tests is not the same as running the existing suite;
  the new test must be able to fail for the reason it targets.
- **ui-adjustment** — fix the design or state source first; visual or interaction
  evidence is required only when the change actually depends on it.
- **project-health** — bounded questions and a stop condition; it reports findings
  and hands decisions on rather than repairing them.
- **current-change-analysis** — reads what exists now, including uncommitted work;
  it does not stage or commit anything to make the change easier to read.
- **review-and-plan** — ends at a reviewable plan. The user decides whether it is
  implemented.
- **commit / version-control** — an optional local node, not a default tail of any
  intent. Only an explicit user request selects it; method text does not make an
  unavailable node callable. Exact scope and fresh host approval are required for
  each write; prior evidence or authorization is not reusable approval.
- **release-preparation** — collects the goal, checks the applicable readiness
  matrix, and reports readiness and blockers. Publishing is a separate decision.

## Risk-based method selection

Choose specialist methods from the dimensions that actually apply; do not build a
scoring engine and do not attach every method to every task.

- **Scope** — how much surface the change touches, and which consumers read it.
- **Ambiguity** — whether the goal, the source, or the acceptance condition is still
  unclear. Ambiguity is answered by a decision, not by more code.
- **Safety and data** — destructive effects, credentials, migrations, user data, or
  anything not reversible by rerunning the task.
- **Lifecycle** — long-lived state: processes, devices, sessions, subscriptions,
  caches, and what happens on cancel or exit.
- **UI** — whether the outcome depends on what a user sees or does, and which
  evidence would show it.

Rules that hold for every dimension:

- more than one dimension applies → run the corresponding specialists, not a bigger
  general review;
- an environment, permission, or missing-capability block stays a block; it is never
  solved by switching to a more expensive model;
- when the dimension list is unclear, state which dimensions you checked and which
  you did not, instead of claiming full coverage.

## Grading a finding

Grade every report item as exactly one of these, and write the next step next to it:

- **blocked** — something the task needs is missing: capability, permission,
  environment, or a source that cannot be reached. The next step is to say what is
  missing and who can remove the block; the work does not continue as if it passed.
- **needs a decision** — the work is understood, but the choice belongs to the user
  or to another owner: the goal moved, the tradeoff was never approved, or the risk
  is theirs. The next step is to ask for that decision and stop.
- **suggestion** — a real improvement that the agreed baseline does not require.
  The next step is to record it as an option; it never silently enters the change,
  and it does not block acceptance.
- **unverified** — the claim was not tested, or the evidence does not reach it. The
  next step is to name the check that would close it. Unverified is not a pass and
  not a failure.

Keep failed and superseded evidence. A later green run does not erase what failed
unless the failure was actually addressed.

## Readiness diagnosis

When a component looks unavailable, report the four layers separately instead of
collapsing them into "does not work":

1. **Configuration exists** — the entry and its config values are present for this
   profile.
2. **Skill visible** — the method is discoverable in the current scope, under the
   name that scope resolves.
3. **Component active** — the plugin row is loaded and serving, not merely installed
   or listed.
4. **Call actually usable** — a real invocation under the caller's own policy,
   approval, and execution world succeeds.

Before side effects, check tools, services, routes and permissions with read-only
configuration/capability queries. If availability cannot be established, report the
gap rather than probing with a write. Diagnosis defaults to read-only: use the
available configuration and capability queries first. Do not spend a paid model call or start a device side effect only to
find out whether something is mounted, and do not add a resident diagnostic database.
A successful lookup at one layer is not evidence for the next: "config present" does
not mean "call usable", and a listed plugin is not a working capability.

## Configuration upgrade guide

When a component's configuration shape changes:

- **Route model overrides through `routes`.** Migrate existing per-role model
  overrides instead of keeping two representations of the same choice.
- **Defaults belong to code.** A default that ships in code does not need to be
  written into a profile; a sparse profile keeps meaning "user chose this", not
  "snapshot of today's default".
- **Never guess deployment defaults.** If the effective default cannot be read for
  the layer in question, say it is unknown and refuse the edit; do not invent a
  provider/model pair or silently fall back to one.
- **Respect layer replacement.** Later configuration layers replace a whole row's
  config rather than deep-merging; keep the rest of that row intact when overriding
  one field.
- **Fail closed on unknown shapes.** A layer whose schema or default cannot be read
  is not editable by guesswork.
