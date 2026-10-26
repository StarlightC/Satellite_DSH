# Difficulty, role tiers, and reassessment

This is a parent reasoning method, not a scoring service or a persisted task
controller. The parent owns classification and reassignment; executors return
observations and recommendations. Do not add a separate model call just to rate a
task, or treat a number or a completed Agent run as verified evidence.

## Two independent choices

- **Execution difficulty**: `light`, `standard`, or `critical` describes the whole
  task's risk and the review/validation obligations it needs.
- **Node role tier**: `light`, `standard`, `senior`, or `critical` selects a
  configured role for one solution, implementation, or review unit.

The shared word `critical` does not couple the two choices. Critical execution
difficulty does not automatically require a Senior or Critical role; it still needs
the task-level review and validation obligations. A Critical role may be assigned to
a Standard task whose stubborn problem has resisted lighter attempts. Neither role
tier grants extra permission, and neither guarantees that the work is risky or
irreversible.

Only `solution`, `implement`, and `review` have default role-tier mappings.
`context`, `validate`, and `signoff` have no default mappings: call them without
`tier`. A deployment may add its own `nodes.<node>.tierRoles` for any node; that is
configuration, not a reason to invent a different default ladder.

Classify before selecting those roles. Start provisionally if investigation is
still needed; uncertainty is a reason to gather bounded context, not to block that
context behind a rating prerequisite. Reassess after context, solution, review,
validation, scope changes, or a user report that the issue remains.

Critical work does not automatically require Senior or Critical implementation.
Split safely separable outcomes with clear ownership, interfaces, and merge order;
choose the lightest safe role for each unit while retaining the whole task's risk
checks. Complete each unit's necessary review and validation before dependent
implementation; this does not require repeating unchanged evidence or full
validation for every small unit. Separate files alone do not establish safe parallel work.

## Four role-tier responsibilities

These are method responsibilities, not model names or permission levels.

| Tier | Use for | Must not become |
| --- | --- | --- |
| light | A local, low-ambiguity unit with a clear boundary and easily reversible change. State the local scope and unexamined impact. | A way to skip an actually required safety, integration, device, or review check. |
| standard | Conventional solution work and a complete impact check against the real diff and consumers. | An assumption that local checks cover cross-module effects. |
| senior | Cross-module coupling, complex constraints, or an existing failure history that makes a simple local unit unsafe. Recheck prior evidence; do not repeat rejected methods. | A reset of the failure history or an automatic choice merely because the task is high risk. |
| critical | Re-examine the core assumptions, construct counterexamples, and pursue a stubborn problem in depth. | A requirement that every item be irreversible, a guaranteed negative conclusion, or a pass only after every possible concern is exhausted. With sufficient evidence, a Critical role may pass. |

A lower tier must still run the checks that are actually necessary for its unit.
"Light" limits the scope and ambiguity of the role, not the safety obligations that
the task already has.

## Proportional execution and evidence reuse

Difficulty selects necessary obligations, not a mandatory tour of every node. With
sufficient current context, simple version/wording/value edits can use implement +
targeted checks; dependency and script changes require their actual impact checks.
Do not mechanically repeat context, solution, review or full validation. Do retain
any agreed necessary review, forced slots and approval: duplicate execution and an
outstanding obligation are different things. Check tool/service/route/permission
availability without side effects before planning an execution that depends on it.

Reuse evidence only with its source, revision or digest, covered scope, exact
command, relevant environment and untested items recorded, and only while all
relevant inputs are unchanged. Changed inputs invalidate the affected coverage,
not necessarily unrelated checks. Evidence reuse never reuses authorization or
host approval. See [the evidence record](../../satellite-validation/references/evidence-record.md).

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

Direct Critical difficulty triggers take priority over the total: scope 3, risk 3,
ambiguity 3, data/security 2+, UI 2 involving complex state/shared primitives or
design-source/screenshot-sensitive fidelity, a genuine need for a Senior or Critical
implementation role, or repeated Standard failure/unresolved review or test
uncertainty. Apply a domain-specific exception only when the applicable domain method
defines it and its evidence conditions hold; do not generalize it to arbitrary
identifier renames. An exception removes only its named trigger, not other risks or
the total. UI 2 alone is not a blanket Critical trigger.

These are judgment anchors, not an arithmetic proof. If an anchor does not settle
the task, explain the uncertainty rather than inventing precision. Domain-specific
checks come from the applicable project/domain skill, not a generic high-tier
Agent. For Android, load `android-change-review` and its linked Android risk
reference when platform risks affect planning or reassessment; if that skill is
unavailable, report the missing method instead of inventing an Android specialist.

## Dispatch through the existing node

Use `satellite_node` with `tier` only for `solution`, `implement`, or `review` when
deliberately selecting a role tier. Omitting it preserves the node's configured
default role. An explicit tier with no configured mapping is a
configuration/capability gap, not permission to silently fall back; the node's
default role remains available by omitting `tier`.

Choose solution, implementation, and review separately. Validation has no role tier
by default; it is still a required evidence step and cannot be replaced by a higher
implementation or review role. When a needed role or specialist is unavailable,
return the gap or ask the user for direction.

Use the existing `task` and `unit` to carry the chosen scope, execution difficulty,
assigned role tier and its rationale, required checks, prior attempts with failed
count/limit at that tier (or the explicit history gap), current partial changes and
remaining blocker. Keep this short and link detailed evidence. `facts` may carry
semantic context, but it is neither authorization nor verified machine state.
A child receives its bounded task, not the entire parent policy.

A suspended call freezes its role choice. Resume it to finish that call; choose a
different tier in a new bounded call carrying the evidence for the change, not by
changing the old call's `resume` arguments. The reported selection is not proof of
execution: a before pause or route refusal may have started no base Agent. An after
resume may reuse an earlier base result.

## Failure budgets and upward reassignment

Only implementation has the **three failed attempts per unit at its current tier**
budget: the initial attempt plus two corrections justified by new evidence, whether
inside one child call or across calls at the same tier. Stop earlier when no useful
correction is supported. One attempt is one coherent hypothesis/change whose targeted
acceptance condition is shown still failing. Multiple diagnostics from one check are
one attempt; reads, successful intermediate checks and incidental typos are not.

The executor reports hypothesis, failure evidence and what another correction
would change, plus count/limit and partial edits. The parent carries that history
across children. New task names, cosmetic subdivisions, refreshed context or a
transient environment problem do not reset the same unresolved blocker's budget. A
higher tier has its own bounded budget and inherits the earlier evidence as history;
earlier failures do not consume attempts against the new tier. Do not run extra
checks just to count, or infer failure counts from tool errors, node `kind`,
`stopReason`, or a missing report. Missing evidence remains a gap.

- Implementation: Light → Standard → Senior/Critical or relevant specialist. An
  exhausted Critical unit stops with the unresolved gap and requests a decision;
  do not start another endless loop. A higher tier inherits the earlier evidence.
- Solution and review do not use the three-attempt budget. Move to a lighter or
  higher tier only when the evidence changes the ambiguity, coupling, or required
  checks. Critical is a deeper re-examination, not a fixed retry count.
- An unresolved Critical solution or review returns its evidence limitation and the
  decision it needs; it does not silently accept, invent a specialist, or loop.
- Validation failures are evidence for the task and may change difficulty or a later
  implementation/review assignment. They do not create a validation role tier or
  automatically justify a stronger model.

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
