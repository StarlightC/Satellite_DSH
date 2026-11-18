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
it does not widen reads or the child's tools. A danger-full-access parent is a
valid wider parent policy, but the actual Git write still requests workspace-write,
full native confinement and allowed-once; the child is not promoted. The main session still has no
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
SHA-1 format 0, including shallow clones (never auto-fetch). Normal Git config
syntax, repeated keys, unknown inert tooling keys and attributes/macros are allowed.
Unknown config is not claimed universally safe: the fixed five actions and controls
below define the reachable execution boundary. Includes, worktree redirection,
unobserved worktree config, partial clones, alternate object sources, grafts and
split index remain unsupported. Config is parsed locally before any Git startup;
no untrusted Git invocation is used to parse it.

Execution entry → control:
- Hooks (including reference-transaction), fsmonitor → fixed core.hooksPath=/dev/null
  and core.fsmonitor=false. Their repository settings need not be deleted.
- add/status/diff clean/process filters → executable filter.clean/process definitions
  are rejected before Git, independent of attribute source or macro. Smudge-only
  configuration is inert: none of the five actions checks out files.
  Inert filter names, text=auto, merge=union, linguist attributes and macros work.
- diff drivers/textconv → every diff uses --no-ext-diff/--no-textconv; no action merges.
- Pager/editor/signing → --no-pager, commit -m/--no-gpg-sign, log --no-show-signature,
  fixed commit.gpgSign=false/tag.gpgSign=false. Configured programs are inert here.
- Auto-GC/maintenance → fixed gc.auto=0/maintenance.auto=false.
- Includes/external attrs/worktree → includes and core.worktree rejected;
  core.attributesFile=/dev/null, system attrs disabled, worktree config rejected.
- Remote/object sources → no remote action, clean environment, protocols disabled,
  GIT_NO_LAZY_FETCH=1; partial clones/promisor packs and alternates rejected.

Scan includes ignored files with no scan-level repository entry/byte quota;
Git output resource caps below still limit which operations can complete. Ordinary
regular/hardlinked files are content-hashed in full; symlinks bind mode and raw link
text without following them (directory links are leaves). Metadata links/hardlinks
are refused: Git writes there, and an alias could escape the observed write domain.
Worktree .gitattributes symlinks are not followed, matching Git's documented rule.
.gitmodules and index gitlinks are supported without recursing into submodule .git
or .git/modules metadata. Only staging a submodule HEAD/content is unsupported;
stage other files and commit the actual index remain available. Status reports staged
gitlink changes separately as stagedGitlinks (old/new OIDs), since its worktree status
suppresses submodule recursion. Cached diff and commit approval include gitlink
changes with complete old/new OIDs. Large trees cost proportional time.
Real commit is exercised only with simulated host services in temporary fixture
repositories; live-host approval UI has not been demonstrated here.

Snapshots are process-local, single-use, five minutes, and bound to exact caller,
policy, repo/HEAD/index/config/attributes/tree. Any relevant change requires a new
observation and new approval. Commit approval contains whole index and binary
diff, never an abbreviated approval summary. Model-facing Git reads use a 128 KiB
per-stream output cap; complete internal index manifests, status cached raw diffs
and commit approval patches use a 16 MiB per-stream buffered-output resource cap.
These are real operation limits: even a smaller displayed status can be refused
if its internal cached raw diff exceeds 16 MiB. This is not unlimited index or
patch support, nor a whole-process memory bound. Exceeding the applicable cap
is an explicit refusal, never a snapshot
or approval made from truncated data; no artificial approval-reason length gate.
Locks are preserved. Write
failure, cancellation, timeout or lost launch result is conservatively uncertain;
a cancelled write that reached spawn keeps the host's aborted result but carries an
`effect-unknown` note.
The kernel does not eliminate external last-instant filesystem races or isolate
a malicious host Git binary. Report these limits rather than a security guarantee.
