---
name: satellite-change-review
description: Independently review the current change and its consumers against the real diff and the source it touches, then report a conclusion with evidence and limits. Read-only: it does not fix, edit, or commit.
whenToUse: Use as the method for the review node, or whenever an existing change needs an independent conclusion before it is validated or accepted.
---

# Current change review

Review the change that exists now — the real diff — and its consumers, not the
summary someone wrote about the change.

## Method

1. Lock the change first: which files and hunks actually differ, and which
   consumers read them. Name the scope and the stop condition before reading
   widely.
2. Collect the diff with read-only commands. Do not stage, commit, or otherwise
   mutate the repository to make the change easier to read.
3. Read the changed source itself, not only the development summary, and read
   the call sites and consumers the change has to keep working.
4. Compare the change with its stated goal: what it claims to do, what it
   actually does, and what it breaks or leaves out.
5. Report every finding with its evidence location, and mark it as confirmed or
   as an unverified suspicion. State the limits: what could not be read, run, or
   established.

When the change spans several kinds of surface — code, configuration or schema,
skills and public assets, tests — or when it is unclear what a surface has to prove,
read [the review scopes reference](references/review-scopes.md).

## Role tier responsibilities

The tier changes the depth and scope of the same read-only review method. It does
not grant write access, special tools, or a stronger conclusion by itself.

| Tier | Responsibility |
| --- | --- |
| light | Review a local, low-ambiguity change with a clear boundary and direct consumers. State the local evidence and the impact left unexamined; keep any safety check the change actually requires. If evidence leaves that local scope, hand back instead of calling it a whole-change pass. |
| standard | Review conventional work and check the complete impact against the real diff, its consumers, and the touched surfaces. |
| senior | Review cross-module coupling, complex constraints, or a change with existing failure evidence. Recheck the prior findings and avoid repeating a rejected judgment; return what remains unresolved. |
| critical | Re-examine the change's core assumptions and construct counterexamples. Pursue a stubborn issue in depth without treating high risk or total irreversibility as a requirement. With sufficient evidence, a Critical review may pass; when it remains unresolved, stop and request a decision. |

## Repeated findings and tier limits

Compare inherited findings with current evidence, not just the latest report. Solution
and review do not use implementation's three-attempt budget; move between their tiers
only when the evidence changes ambiguity, coupling, or required checks.

- A Light review whose local finding remains unresolved after a rework, or whose
  evidence leaves the local scope, needs Standard review.
- A Standard review whose findings remain repeated or unresolved after a bounded
  retry needs Senior review or the relevant specialist.
- A Senior review that remains unresolved after a bounded rework cycle moves to
  Critical, a specialist, or user direction according to what the evidence shows.
- A Critical review that remains unresolved stops with the unresolved gap and asks
  for a decision; do not loop or invent a specialist.

Report the recurring finding, prior evidence, what remains uncertain and the
smallest needed assignment. Do not self-delegate, fix source, or keep retrying the
same review under a new name. Missing specialist capability is a gap, not a pass;
external access or permission failures are not a reason to buy a stronger model.

## Output

A conclusion with evidence locations, the limits of the review, and the items
that remain unverified. Short statements with exact locations; do not restate the
diff and do not invent a report format.

## Do not

- edit, write, move, or delete any file, and do not auto-fix what you find;
- stage or commit anything;
- treat the development summary as evidence;
- present an unverified suspicion as a confirmed defect;
- claim a check you did not run.
