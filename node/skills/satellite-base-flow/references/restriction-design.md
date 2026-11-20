# Functionality-first restriction design

This is Satellite's shared authority for designing, implementing, and reviewing
restrictions in any domain, not a Git-specific policy. Apply it within the user's
agreed goal; it does not authorize a new capability or change an existing tool.

## Default and boundary

Prioritize usable functionality when designing limits. Start with the minimum
restrictions needed for concrete risks and actual operating conditions; do not add
unsupported limits for hypothetical safety. By default, deny the specific risky
behaviour (a blacklist / targeted-denial strategy), rather than allow only familiar
cases. Unknown configuration, scale, or unforeseen use alone is not grounds for
rejection. Control the risky entry point, not every configuration you do not know.

This does not remove real permission checks, user authorization, isolation
boundaries, or explicit permission for destructive actions. Unknown authorization
or an unverified isolation guarantee is a concrete boundary gap, not permission to
proceed. A closed operation protocol or executable instruction set can justify an
allowlist: state why membership defines that boundary and why targeted denial is
insufficient. The default is not arbitrary execution of unknown commands.

## File access and command execution scope

This applies to every node and role, not only the read-only ones. A read-only sandbox
is not privacy-safe: reading a file still reads its content.

- **State the scope and the stop condition first.** Before reading or running
  anything, name what the task actually needs and what you will not touch. Prefer
  the exact files and the subdirectories the task has already confirmed.
- **`cwd` is an execution directory, not a path restriction.** Check what a command
  actually targets and what it triggers indirectly — helper scripts, wrappers, child
  processes, build tools — not only where it starts.
- **Review a coarse search before running it.** A whole-project scan or any coarse
  recursive search states its necessity, the narrower alternative and why it is
  insufficient, the evidence expected, and the stop condition. If that necessity
  cannot be shown, narrow the search or stop; do not scan first and justify after.
- **Filesystem root and user home directory.** Broad operations there run only when
  clearly task-related, demonstrably necessary, and covered by the user's
  authorization and host approval. Without that complete necessity they do not run.
- **No going around the scope.** `../` traversal, absolute paths, symlinks, helper
  scripts, and delegating the read or command to another agent are not a way to reach
  what the task scope excludes.
- **Keep the access the task really needs.** An exact external file the task names,
  and the toolchain or dependency resources a normal build requires, stay available.
  This is not a mechanical ban on normal builds.

These are model-behavior constraints on how a node works. They add no hard read
isolation and do not replace the host file sandbox, host approval, or the user's
authorization.

## Evidence for each added restriction

Before proposing or adding a restriction, give a short, source-backed account of:

- the concrete risk and evidence: the real entry path, trigger, existing guarantee,
  and reachability (a theoretical possibility or constructible fake is not enough);
- its scope: which input, action, or entry point it blocks and why;
- its impact on normal functionality and existing user workflows;
- the least restrictive alternative, and why a narrower control is insufficient;
- representative real scenarios that will check both the risky path and normal
  supported use; mark unavailable evidence and untested scenarios explicitly.

Missing evidence for a new restriction calls for bounded investigation or a
narrower proposal, not a blanket rejection of unfamiliar use. A decisive missing
fact about the proposed change may still stop that change; it does not establish
that the user's unknown configuration is unsafe.

## Design, implementation, and review

Design includes normal-workflow compatibility and real-scenario validation, not
only the rejection path. Implementation keeps the control local to the evidenced
entry point. Review challenges unsupported limits and checks whether the least
restrictive control preserves normal use under actual conditions.

Tests that merely assert the rejection rules just designed do not prove those
rules are justified. Use evidence independent of the rule to establish the risk,
and actual-path checks to establish functionality and compatibility. Preserve
unverified limits honestly; a passing refusal test is not proof of correctness.
