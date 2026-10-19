---
name: android-change-review
description: Review the current Android change against the declared platform check faces — API, lifecycle, resources, security, UI — and report findings with evidence and limits, without fixing anything.
whenToUse: Use as the method for the android.platform-review slot extension after the review node's base step has produced its own report.
---

# Android change review

## Purpose

Independently review the current change on the platform faces the caller
declared, and hand back what the base review may have missed:

- findings, each tied to a location the reviewer actually read;
- which declared check faces were covered and which were not;
- limits: what could not be judged, and what would close the gap.

## Method

1. Read the declared files at the declared revision plus the base report you were
   given. If the change is wider than the declared scope, say so instead of
   widening the review silently.
2. Review only the declared check faces:
   - `api`: platform/API level and compatibility of what the change calls;
   - `lifecycle`: component, process and state-transition behaviour;
   - `resources`: resource qualifiers, configuration changes, density/locale;
   - `security`: exported components, permissions, storage and intent surfaces;
   - `ui`: interaction, accessibility and state rendering.
3. Classify each finding: must-fix, worth improving, or observation. Give the
   exact source location for each.
4. Keep findings and "not checked" separate. A face you did not cover is a gap,
   not a pass.
5. Report limits explicitly, including anything only a device could confirm.

## Do not

- modify files, run gradle, or start a device;
- turn the base report into your own conclusion by restating it;
- treat a clean result as acceptance — the caller decides that.
