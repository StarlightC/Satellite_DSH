---
name: satellite-acceptance
description: Acceptance for Satellite DSH: state what is accepted, on which evidence, and what stays limited or unverified — without publishing or claiming more than the evidence supports.
whenToUse: Use for the `signoff` node, and whenever a change is presented as done and someone has to say what is actually accepted — including when evidence is missing, a check was skipped, or the decision belongs to the user.
---

# Acceptance

Acceptance is a claim about evidence, not a summary of effort. This node states
what is accepted, what is not, and where the limits come from. It does not commit,
publish, upload, or fix.

## Gather the inputs

- the goal as it was actually agreed, including any decision that changed it;
- the changed scope: which files, units, or behaviours are in question;
- the verification evidence: the commands that really ran, their results, and
  where the raw output lives;
- the review findings, and how each one was resolved or left open;
- the decisions taken on the way, and by whom.

## Check every claim

For each statement you intend to accept:

1. cite the evidence and its exact location; a claim without evidence is not
   accepted;
2. if a check could not run, say why — environment, permission, cost — and list it
   as unverified instead of assuming it passes;
3. a finished agent run is a runtime fact, not business acceptance; do not
   translate it into a pass;
4. keep failed and superseded evidence: a later green run does not erase what
   failed, unless the failure was actually addressed.

When acceptance covers several kinds of claim, read
[the evidence claims reference](references/evidence-claims.md) for what counts as
evidence per class, how to keep a runtime fact apart from business acceptance, and
when a limit stays open.

## State the limits

Name, in one line each: what was not tested (platforms, variants, conditions), what
is known-broken or deferred, and which risks remain for whoever uses the result.
An empty limit list usually means the check list was too narrow, not that nothing
is limited.

## Decide or hand back

Return one of three outcomes, plainly:

- **accepted** — with the evidence and the limits;
- **not accepted** — with the specific missing or failing evidence;
- **needs a decision** — when acceptance belongs to the user: the goal moved, the
  risk is theirs, or the tradeoff was never approved. Ask for that decision
  instead of accepting on their behalf.

Do not re-run destructive or expensive steps in order to turn a result green, and
do not start the fix yourself: a gap becomes a decision or a later unit.
