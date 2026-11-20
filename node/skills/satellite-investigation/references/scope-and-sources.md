# Scope and sources

Read this when the question is settled but the reading plan is not: which sources
decide it, which revisions count, and what makes the answer checkable. It extends
[the investigation method](../SKILL.md); it does not replace it.

## Write the scope statement first

Three lines, before reading widely:

1. **Question** — the one thing this task needs answered; if two questions are
   independent, split the units.
2. **Sources** — the files, settings, or states that hold the answer, named as
   precisely as possible.
3. **Stop condition** — what you will not read, and why what you have is enough.

A plan that grows while reading has no stop condition. Cut it back rather than
following every interesting lead.

The sources line is also the file and command boundary: name exact files or the
confirmed subdirectories, and what each command actually touches. `cwd` is an
execution directory, not a path restriction — indirect effects such as helper
scripts, wrappers, and build tools count.

When only a whole-project scan or a coarse recursive search can answer, extend the
plan with four lines before running it: the necessity, the narrower alternative that
was insufficient, the evidence expected, and the stop condition. Without them, narrow
the search or stop; scanning first and justifying later is not a scope statement.
The exact external files the task names and the ordinary toolchain or dependency
resources stay in scope: the rule narrows breadth, not the task's necessary access.

## Record a fact so it can be rechecked

For each fact, capture:

- **owner** — the file, setting, or state that holds the truth, not the summary that
  mentions it;
- **location** — a path with the line or symbol, so the next reader goes there;
- **revision** — the version or digest the fact was read at, when the source can
  change under the task;
- **freshness** — whether you read it now or relayed it from an earlier step.

Prefer the deciding source over documentation about it, and primary over derived.
When two sources disagree, report both and say which one the code or runtime
actually follows rather than picking one quietly.

## Keep gaps as gaps

- "Not checked" is a finding; write it down with the check that would close it.
- A missing capability, permission, or unreachable source is a block, not a reason
  to guess the value.
- Do not initialize, update, or rebuild an index here, and do not mutate anything to
  make a source easier to read: this node is read-only, and its output is facts plus
  a stop condition, not a change.
