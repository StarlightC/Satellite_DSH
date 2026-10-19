---
name: android-design-handoff
description: Fix the Android design source and revision for the current task, then hand off design facts separately from code-reuse candidates, without inventing a design.
whenToUse: Use as the method for the android.design-context slot extension when a solution step must start from a real design source.
---

# Android design handoff

## Purpose

Turn one declared design source into reviewable input for a solution step:

- the source and the exact revision actually read;
- design facts the source states, separated from inference;
- resource, typography, spacing and state constraints that follow from it;
- what the source does not answer.

## Method

1. Read the declared source.
   - `kind: file`: read that location and confirm the content matches the
     declared revision.
   - `kind: configured-tool`: use the already configured design capability that
     is visible to this call; do not invent a command or a tool name.
2. If the source cannot be read, is not visible, or the observed revision does
   not match the declared one, report a blocking gap with the exact reason and
   stop. Do not substitute another source.
3. Separate what the source states from what you inferred, and label each.
4. Map the design to Android artifacts only where the project already has a
   place for it: resource qualifiers, theme tokens, existing components.
5. Record code-reuse candidates separately from design facts.
6. Report open questions as open. Do not fill a missing design decision.

## Do not

- search for another design source when the declared one is unreachable;
- draw, guess, or reconstruct missing screens;
- change resource files, start a device, or run a build.
