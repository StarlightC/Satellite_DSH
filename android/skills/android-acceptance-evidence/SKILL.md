---
name: android-acceptance-evidence
description: Summarise the Android evidence that already exists — tests, design, device — with its locations, revisions and gaps, so the acceptance step can judge; it does not accept on its own and never publishes.
whenToUse: Use as the method for the android.acceptance-evidence slot extension when an acceptance step must account for domain evidence before it decides.
---

# Android acceptance evidence

## Purpose

Give the acceptance step an honest inventory before it decides:

- which evidence exists, where it is, and at which revision;
- which declared claims are actually supported by a source;
- what is missing, contradicted, or still unverified.

## Method

1. For each declared claim, read its sources and compare the observed revision
   with the declared one.
2. Separate the caller's claim (`reportedResult`) from what the sources show. A
   claim of `passed` with no readable supporting source is unsupported, not
   passed.
3. Cover the declared evidence kinds as they apply: build output, unit tests,
   device/UI runs, performance or memory measurements.
4. Report per claim: supported / contradicted / unsupported, with the location
   read, plus the full list of gaps and of anything never verified.
5. State plainly what a reader must still confirm before accepting.

## Do not

- accept the task, sign off, or declare readiness on your own;
- read signing material, keystores, or credentials;
- produce, publish, or upload anything;
- create missing evidence to make the inventory look complete.
