# Service and repository limits

The reserved `version-control` role has no tiers or aliases. Only its live base
activation has access to the local tool. The runtime verifies exact child object
and ownership, installs a monotonic scope guard before execution, denies derived
scopes and all other execution entries, and removes membership/guard at teardown.
Allowed direct method tools are only skill, question and read, plus the local tool.
Main/implementation/sibling sessions cannot call it. Ordinary configuration cannot
widen the role or bind it to another node; UI may configure its model route.

Reads use services from the real child context: tools, workingDirectory, fs,
sandboxPolicy, sandbox and subprocess. Writes use the same service set from the
delegating parent's own scope (see below). No root fallback. Host fs must
explicitly map workspace/cwd and fixed POSIX binaries to the SAME host files with
identity process paths; subprocess contract shares that fs execution world.
Remapped, non-shared, Windows, missing/unknown providers are blocked. Each Git
process requires full native read-only/workspace-write confinement, bounded by
parent policy, and uses clean `env -i` argv; no shell or wider sandbox request.
Trusted backend contracts are assumed, not proof against a malicious host.

The inspected DSH delegated-child composition pins approval policy to `never`;
the child never asks for or performs a write. Instead the child submits a frozen
intent plus its private single-use snapshot handle, and the runtime runs a SEPARATE
parent-owned operation inside the parent's still-open explicit `satellite_node`
call. The parent identity is bound by the node runtime at child creation (not by
model arguments or facts); approval, sandbox, subprocess, cwd, fs mapping and
policy all come from the parent's own scope. The parent re-observes the repository,
requires it to equal the child's snapshot and the same workspace/cwd, asks the
host for a real `allowed-once` for the exact plan (not reusable), and rechecks
repo/HEAD/index/config/files/argv/expiry/parent policy after its final confinement
and immediately before spawn. Parent read-only/`never`/no answerer/missing service,
lost ownership or unknown mapping are blocked. Only stage/commit use the handoff;
it does not widen reads or the child's tools. The main session still has no
git/shell tool. A file sandbox is not network isolation.

Supported layouts: an ordinary .git directory (registered linked worktrees under
`.git/worktrees/` are inert data), or the repository root being a linked worktree:
an absolute `gitdir:` gitfile naming a canonical `<commondir>/worktrees/<name>`
whose `commondir` resolves to a canonical, non-bare `.git` and whose `gitdir`
backlink names exactly this root's `.git`. Relative gitfiles, nested layouts,
`config.worktree` and `extensions.worktreeConfig` are rejected. The bounded scan
covers the worktree and the whole common directory (including the private gitdir
and sibling worktrees' metadata) under the same limits; any lock there blocks
writes. Snapshots bind the layout; requests on one common directory are serialized.
The repository root must still be inside the workspace. Only when the validated
common directory is outside it does a write call add exactly that directory as
`additionalWritableRoots` (stated in the approval plan; same policy for probe and
real confinement; gitdir/commondir must pass the host-shared mapping check, which
is rechecked after approval and final confinement). That directory includes hooks
and config: this tool revalidates config and disables hooks every time, but other
host Git invocations are not protected by it.
SHA-1 format 0, bounded strict config and safe
attributes. Only `[lfs] repositoryformatversion = 0` is accepted as inert metadata;
`[filter "lfs"]`, filter attributes/drivers, hooks config, includes, external paths
and unknown config are rejected before Git. Ordinary inert origin URL is allowed
but never used. No bare repo, submodules, partial clone, alternates,
shallow/split index, symlink/hardlink/special paths. Scan includes ignored files
and has no repository entry/byte quota: every regular file is hashed in full by
streaming (no whole-file buffering except parsed config/attributes). Large trees
cost proportional time. Repositories containing dependency symlinks can be
unsupported; the scan is never silently skipped.
Real commit is exercised only with simulated host services in temporary fixture
repositories; live-host approval UI has not been demonstrated here.

Snapshots are process-local, single-use, five minutes, and bound to exact caller,
policy, repo/HEAD/index/config/attributes/tree. Any relevant change requires a new
observation and new approval. Commit approval contains whole index and binary
diff; oversized plans are refused, not truncated. Locks are preserved. Write
failure, cancellation, timeout or lost launch result is conservatively uncertain;
a cancelled write that reached spawn keeps the host's aborted result but carries an
`effect-unknown` note.
The kernel does not eliminate external last-instant filesystem races or isolate
a malicious host Git binary. Report these limits rather than a security guarantee.
