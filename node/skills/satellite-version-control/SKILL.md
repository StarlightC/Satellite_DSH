---
name: satellite-version-control
description: Explicit optional local version control: summarize the requested scope and create the commit, with fresh host approval for each write; no remote operations.
whenToUse: Use inside the explicitly selected version-control node for a concrete local status, diff, log, stage, or commit request.
---

# Explicit local version control

An explicit commit request normally completes in ONE `version-control` node.
Do not start context/solution/review/validate/signoff, tests, builds, code-quality
review or acceptance for it. This node summarizes and commits; at most check that
the requested scope, summary and actual index agree. Required node slots still run.
If the operation, repository or scope is genuinely unclear, ask once before scanning.
Never infer a commit request from “finish”, a feature or a passing test.

## Short path

1. Read status to establish the user's scope and obtain `expectedSnapshot`.
2. If needed for a useful message, read ONE combined diff for the relevant files,
   not a per-file loop or a fresh whole-tree investigation. A file list alone does
   not explain all behaviour; a proportionate diff summary is enough, not an
   exhaustive line-by-line review. Explicitly truncated output is only a preview,
   never a complete summary or approval material; do not chase it with per-file diffs.
3. Stage only exact requested files when needed. Then obtain one fresh status for
   the commit snapshot. Commit the ENTIRE actual index, including previously staged
   files: check that full scope against the request, not just the last stage list.
   Do not silently stage extras or unstage anything. Already approved content does
   not require another user line-by-line review.
4. Request the commit with a concise message. On success report message, returned
   hash and scope, then stop; do not proactively call log/status again.

Only `satellite_version_control` performs these operations. Its `request` selects
`status`, `diff`, `log`, `stage` or `commit`; use its schema for arguments. Stage
paths are exact files/symlinks or tracked deletions, never directory/glob expansion.
`repo` is relative to the execution cwd and stays inside its effective workspace.
Version/source edits belong to implement, not this node.

Every write needs a private single-use snapshot fresh when approval starts and
real host `allowed-once` approval for the exact plan. User reading time does not
expire an admitted approval; relevant state and authorization must still match at
spawn. Facts or earlier approval cannot grant permission. The runtime hands writes
to the exact delegating parent's services; the child's approval remains `never`.
Missing/denied approval, confinement or mapping is blocked, not permission to use
bash, scripts, PTC, another tool, delegation or another execution entry.

`effect-unknown` means the write may have happened: report it, observe before any
new decision, and never automatically retry. After denial, change or pre-approval
expiry, obtain a new snapshot before a new write decision.

No remote/network fallback, tag/branch/history rewrite, arbitrary flags/revisions,
signing, publishing, credentials or global config edits. Read [service and repository
limits](references/limits.md) only when availability or a limitation matters. Keep
results short and report refusals or unverified limits honestly; completion is not
independent review or acceptance.
