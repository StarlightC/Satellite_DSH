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
