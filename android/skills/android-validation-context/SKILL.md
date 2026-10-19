---
name: android-validation-context
description: Collect the bounded Android validation context (module, variant, test entry points) before a validate node runs, without starting a device or running tests.
whenToUse: Use as the method for the android.validation-context slot extension, or when a validate step needs to know which module and variant it is about.
---

# Android validation context

## Purpose

Produce the facts a validate step needs before it runs a command:

- the Gradle module(s) the change actually touches;
- the build variant and the test task that cover them;
- the test source locations that exist today;
- anything that makes those entries unavailable.

## Method

1. Read the project's build files and settings to find the modules, not the
   directory names.
2. Map the current change to the modules it affects. Do not scan the whole
   repository when the change is local.
3. Resolve the variant and test task from the project configuration; do not
   assume `test` or `assembleDebug` exist.
4. Report the exact command entry points and their source locations.
5. If a value cannot be established from the project, report it as missing
   rather than guessing.

## Do not

- start an emulator, install an APK, or run tests in this step;
- claim device or UI evidence;
- read design sources — that belongs to the solution step.
