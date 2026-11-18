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
