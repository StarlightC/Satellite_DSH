# Evidence claims

Read this when acceptance depends on several kinds of claim, or when it is unclear
what would count as evidence for one of them. It extends
[the acceptance method](../SKILL.md).

## What counts as evidence, per claim class

- **Compile, type, lint** — the real output of the real command in the real
  workspace, including failures that were fixed.
- **Automated tests** — the command, the result, and which assertions actually ran;
  a test that cannot fail for the claim proves nothing.
- **Runtime or manual observation** — what was executed, where, under which policy,
  and what was observed. A run that completed is not a passing result.
- **User-visible behaviour** — the observed screen or interaction plus the state it
  started from, or an explicit statement that this class stays unverified.
- **Documentation and assets** — the shipped file was read and its declared entry
  point and links resolve; content that exists but is unreachable is not delivered.

## Keep the classes apart

A finished agent run is a runtime fact, not business acceptance. A successful build
does not establish runtime behaviour, and a report about a check is not the check.
Do not translate an unverified class into a pass because the other classes passed,
and do not accept a claim whose only evidence is a summary someone wrote.

## Limits are part of the result

Name what was not tested (platforms, variants, conditions), what is known-broken or
deferred, and which risks remain for whoever uses the result. An empty limit list
usually means the check list was too narrow. When a limit cannot be closed inside the
current scope, say which check would close it.

## When the decision is not yours

Return the outcome plainly: accepted with evidence and limits, not accepted with the
specific missing or failing evidence, or awaiting a user decision when the goal moved
or the risk is theirs. Do not accept on the user's behalf, do not re-run destructive
or expensive steps to turn a result green, and do not fix or publish anything here.
