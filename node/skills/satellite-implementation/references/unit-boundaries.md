# Unit boundaries

Read this when a unit is hard to state in one block, or when a review finding has to
become a new unit. It extends [the implementation method](../SKILL.md).

## One unit, one reviewable change

A unit is small enough when all four fit in a short block:

- what changes, and why this is the agreed baseline;
- the files or areas in scope, and what is explicitly out of scope;
- the check that will show the unit works;
- the decision still missing, if any.

If the scope line needs "and" to hold unrelated things together, or you cannot say
what would be out of scope, split the unit. Splitting is cheaper than reviewing a
diff whose parts have different risks.

## Rework units

A review finding becomes its own unit: fix only what the finding established, and
keep the earlier evidence and the reason for the change. Do not re-do the whole
original unit under a new name, and do not fold an unrelated improvement into the
rework. If the finding shows the agreed baseline itself was wrong, stop and hand the
decision back instead of widening the change.

## Keep the diff reviewable

- the smallest change that satisfies the unit, using existing helpers and conventions;
- no reformatting of neighbouring code and no "improvements" the unit did not ask for;
- no test that only restates the implementation; add the check the unit needs;
- no commit, tag, push, publish, or credential handling in this node.

## What "checked" means here

Run the compile, type, or lint check for what you touched and report its real result,
including a failure you then fixed. Full verification belongs to `validate`; a
partial check is not verification, and a green check is not acceptance. Environment
or permission blocks are reported as blocks — not solved with a more expensive model
and not a reason to call the unit done.
