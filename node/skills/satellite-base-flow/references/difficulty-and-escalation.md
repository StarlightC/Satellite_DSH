# Difficulty, role tiers, and reassessment

This is a parent reasoning method, not a scoring service or a persisted task
controller. The parent owns classification and reassignment; executors return
observations and recommendations. Do not add a separate model call just to rate a
task, or treat a number or a completed Agent run as verified evidence.

## Two independent choices

- **Execution difficulty**: `light`, `standard`, or `critical` describes the whole
  task's risk and the review/validation obligations it needs.
- **Node role tier**: `light`, `standard`, or `senior` selects a configured role for
  one implementation, review, or validation unit. `critical` is not a role tier.

Classify before selecting those roles. Start provisionally if investigation is
still needed; uncertainty is a reason to gather bounded context, not to block that
context behind a rating prerequisite. Reassess after context, solution, review,
validation, scope changes, or a user report that the issue remains.

Critical work does not automatically require Senior implementation. Split safely
separable outcomes with clear ownership, interfaces, and merge order; choose the
lightest safe role for each unit while retaining the whole task's risk checks.
Review and validate each unit before dependent implementation. Separate files
alone do not establish safe parallel work.

## Evidence-based rubric

Use these anchors when the classification needs explaining. Give the deciding
facts and unknowns; do not repeat the entire table at every node.

| Dimension | Anchors |
| --- | --- |
| Scope (1–3) | 1: local component/resource; 2: one feature or module; 3: multiple modules, layers, or ownership boundaries |
| Risk (1–3) | 1: easily reversible, low impact; 2: user-visible regression risk; 3: crash/data loss, migration, security, or difficult recovery |
| Ambiguity (1–3) | 1: clear goal and acceptance; 2: bounded assumptions; 3: unclear requirement, root cause, ownership, or solution |
| Data/security (0–3) | 0: no impact; 1: simple non-sensitive local data; 2: account/network state, permissions, privacy-sensitive behaviour; 3: credentials, sensitive personal data, authentication, or payments |
| UI (0–2) | 0: none; 1: local established pattern; 2: complex states, shared design primitives, source-sensitive fidelity, or visual tradeoffs |

The valid total is **3–14**. With no stronger trigger, 3–4 suggests Light, 5–7
Standard, and 8+ Critical. Ordinary user-visible behaviour and release-readiness
work are at least Standard even with a lower total. Judge risk by regression
consequences, not visibility alone: a clear, easily reversible visible change can
have risk 1 and still require the Standard execution floor. Release preparation is
not permission to sign, publish, upload, commit, or roll out.

Direct Critical triggers take priority over the total: scope 3, risk 3,
ambiguity 3, data/security 2+, UI 2 involving complex state/shared primitives or
design-source/screenshot-sensitive fidelity, a genuine need for Senior
implementation, or repeated Standard failure/unresolved review or test uncertainty.
Apply a domain-specific exception only when the applicable domain method defines
it and its evidence conditions hold; do not generalize it to arbitrary identifier
renames. An exception removes only its named trigger, not other risks or the total.
UI 2 alone is not a blanket Critical trigger.

These are judgment anchors, not an arithmetic proof. If an anchor does not settle
the task, explain the uncertainty rather than inventing precision. Domain-specific
checks come from the applicable project/domain skill, not a generic high-tier
Agent. For Android, load `android-change-review` and its linked Android risk
reference when platform risks affect planning or reassessment; if that skill is
unavailable, report the missing method instead of inventing an Android specialist.

## Dispatch through the existing node

Use `satellite_node` with `tier` only when deliberately selecting a node role tier.
Omitting it preserves the node's configured default role. An explicit unsupported
tier is a configuration/capability gap, not permission to silently fall back.
Use the installed role catalog/configuration to identify available assignments;
a role label, a route record, or a higher-priced model alone is not a specialist.

Choose implementation, review, and validation separately. Light review can serve
a narrow, well-evidenced Standard unit; broader review uses Standard or the
relevant specialist. Light validation is local partial evidence, not a substitute
for required integration, device, security, or visual checks. When a higher or
specialist assignment is unavailable, return the gap or ask the user for direction.
Do not create a three-tier ladder for every other node.

Use the existing `task` and `unit` to carry the chosen scope, execution difficulty,
assigned role tier and its rationale, required checks, prior attempts with failed
count/limit at that tier (or the explicit history gap), current partial changes and
remaining blocker. Keep this short and link detailed evidence. `facts` may carry
semantic context, but it is neither authorization nor verified machine state.
A child receives its bounded task, not the entire parent policy.

A suspended call retains its role choice. Resume it to finish that call; choose a
new tier in a new bounded call, not by changing the old call's `resume` arguments.
The reported selection is not proof of execution: a before pause or route refusal
may have started no base Agent. An after resume may reuse an earlier base result.

## Failure budgets and upward reassignment

For implementation, allow at most **three failed attempts per unit at its current
tier**, including attempts inside one child call: initial attempt plus two
corrections justified by new evidence. Stop earlier when no useful correction is
supported. One attempt is one coherent hypothesis/change whose targeted acceptance
condition is shown still failing. Multiple diagnostics from one check are one
attempt; reads, successful intermediate checks and incidental typos are not.

The executor reports hypothesis, failure evidence and what another correction
would change, plus count/limit and partial edits. The parent carries that history
across children. New task names, cosmetic subdivisions, refreshed context or a
transient environment problem do not reset the same unresolved blocker's budget.
Do not run extra checks just to count, or infer failure counts from tool errors,
node `kind`, `stopReason`, or a missing report. Missing evidence remains a gap.

- Implementation: Light → Standard → Senior or relevant specialist. An exhausted
  Senior unit goes to specialist/user direction, not another endless Senior loop.
  A higher tier has its own bounded budget and inherits the earlier evidence.
- Light review: first unresolved rework cycle, repeated missing-context/changes
  requests, or a second failure on the same objective requires Standard review.
- Standard review/validation: repeated unresolved rework, repeated same-cause
  failure, or an unclear failure after one bounded retry requires Senior or the
  relevant specialist. If unavailable, stop with that gap.
- Senior review: after one unresolved bounded rework cycle, seek the relevant
  specialist/user or return the exact evidence limitation; do not loop indefinitely.

Permission denial, missing dependencies/credentials, unavailable devices/providers,
and transport failures are external blockers, not proof that a stronger model is
needed. At most one clearly transient retry is appropriate; never retry a denied
approval as a workaround. Keep implementation failure history when the external
blocker is cleared. Escalation cannot change the approved product baseline or
silently override configured model/permission rules.

## Downward reassessment

New evidence may justify a lighter assignment. State what changed and why the
remaining scope is safe. Never lower a tier to fit time/tool availability, conceal
unresolved findings, or reset a failure budget. A lower-tier subunit does not lower
the overall task's checks.

Ask the user when reassessment would remove an agreed review/acceptance obligation,
change the approved scope, or change a model-use/cost agreement. A better-supported
rating or a safer decomposition alone does not need a new approval ceremony.

## History limits

Use the evidence already in the conversation and the summaries returned by nodes.
After resume or compaction, recover the relevant prior record before claiming a
remaining budget; if it cannot be recovered, report that uncertainty. This method
does not implement a durable attempt counter or resurrect an interrupted child or
expired node token. It cannot mechanically prove that an Agent counted every
internal hypothesis correctly.
