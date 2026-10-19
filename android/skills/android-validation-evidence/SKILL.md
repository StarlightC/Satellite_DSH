---
name: android-validation-evidence
description: Check declared Android evidence sources against their revisions and report which required evidence exists, which is mismatched or missing, and what stays unverified.
whenToUse: Use as the method for the android.validation-evidence slot extension when a validate node must judge domain evidence beyond the base command result.
---

# Android validation evidence

## Purpose

Judge the evidence the caller declared, without inventing any:

- for each requirement: exists at the declared revision, mismatched, or missing;
- which target (project, module, variant, device) it actually covers;
- what remains unverified and which action would produce the missing evidence.

## Method

1. Take the declared requirements and their sources as given input. Do not add
   requirements that were not declared.
2. For each source, read it and compare the observed revision with the declared
   one. A source that cannot be read is missing, not passing.
3. Match each source's target against the requirement target. Evidence produced
   for another variant, module or device does not cover this requirement; report
   the mismatch with both sides.
4. Record the base node's own result as a separate input: a domain check never
   upgrades a failed base into a pass.
5. Report per requirement: covered / mismatched / missing, each with the exact
   location read, and list the unverified remainder.

## Do not

- run a build, install, or device action to create missing evidence;
- accept a claim of "passed" without reading a source that supports it;
- state that validation passed overall — the caller and the base node own that.
