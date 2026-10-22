---
name: satellite-validation
description: Execute bounded project verification, retain actual evidence and failures, and report unverified scope without fixing source code.
whenToUse: Use for the validate node or a delegated verification unit; orchestration belongs to the parent.
---

# Validation execution

Run only the checks relevant to the assigned unit. Do not call `satellite_node`,
advance the workflow, delegate implementation, or repair source code. Test/build
outputs may be written within the granted workspace; this is not permission to
change the implementation, test expectations, configuration, or dependencies.

## Before running

- Read the assigned scope and any supplied extension evidence. Treat raw reports
  as evidence to check, not verified machine facts or permission.
- Identify the project's existing verification entry points and select the smallest
  checks that demonstrate the claim. State what each check covers and excludes.
- If a command would need a device, network, destructive setup, new dependency or
  additional permission not already allowed, return that prerequisite to the parent.

## Run and return

Execute the selected checks and retain the command, exit status, actual result and
relevant evidence location. A completed agent run is not a passing test.

When deciding what a check has to prove, what to record with it, or how to classify a
run that failed, was blocked, or was only partial, read
[the evidence record reference](references/evidence-record.md).

Report failures without fixing them or weakening assertions. Distinguish code
failures from environment/permission blocks, and list checks not run. Light
validation is local partial evidence: do not silently replace required integration,
device, security or visual checks with it.

On repeated same-cause failures or unresolved rework at Standard, or an unclear
failure after one bounded retry, report the prior evidence and recommend Senior or
the relevant specialist to the parent. Do not self-delegate or rerun deterministic
failures without a changed hypothesis. At most one clearly transient environment
retry is appropriate; never retry a denied approval as a workaround. An unavailable
higher/specialist assignment is a capability gap, not permission to claim success.
Hand back what was verified, what failed, and what remains unverified; the parent
decides reassignment, further checks and acceptance.
