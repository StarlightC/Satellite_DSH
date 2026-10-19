# Recording evidence

Read this when you have to decide what to run and what to keep from a check. It
extends [the validation method](../SKILL.md).

## Select the smallest check that demonstrates the claim

Name the claim first, then the cheapest check that can fail for that reason: a build
or type check for a compile-time claim, the project's own test entry point for a
behavioural claim, a real invocation for a runtime claim. State what the check
covers and what it excludes; "the suite passed" is not coverage of an untested path.

Use the project's existing entry points. Do not add dependencies, change test
expectations, or repair the source to make a check pass.

## Record each run

- the exact command and the directory it ran in;
- environment facts that matter to the result (runtime version, target, feature
  flags), so the run can be judged rather than repeated blindly;
- the exit status and the observed result;
- where the raw output lives, and what it was truncated to;
- what the check proves and what it does not.

## Classify the outcome honestly

- **code failure** — the check ran as intended and the claim did not hold;
- **environment or permission block** — the check could not run, or stopped for a
  reason outside the code: missing tool, denied access, unavailable device or
  network. Report the prerequisite to the parent; do not silently retry with wider
  permissions and do not report it as a code failure;
- **partial or flaky** — the run did not establish the claim. Say which part is
  unverified instead of averaging the result into a pass;
- **not run** — state it plainly. Unverified is a result, not a gap to fill with
  assumption.

## Retain it

Keep the failed run and its output. A later green run does not erase the earlier
failure unless the cause was actually addressed, and you do not re-run expensive or
destructive steps just to turn a report green.
