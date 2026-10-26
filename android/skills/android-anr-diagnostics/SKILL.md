---
name: android-anr-diagnostics
description: Audit Android code for main-thread ANR risk or diagnose an ANR trace, separating proven blocking paths and sync-barrier races from unverified static suspicions.
whenToUse: Load when reviewing a suspected ANR, a main-thread blocking risk, or an ANR stack dump; use the static path only for candidates and the trace path only when an actual dump is supplied.
---

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  performance/anr-audit-and-fix/SKILL.md and its references.
Attribution: Google / Android. Licensed Apache-2.0; see ../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed and reorganized; static versus trace evidence separated. See ../THIRD_PARTY_SOURCES.md.
-->

# Android ANR diagnostics

## Authority and limits

Read-only diagnosis. This skill does not start a device, capture a trace, run
Gradle, edit code, or declare an ANR proven from source alone. Static review
produces **risk candidates**; only a supplied ANR trace, log, or measured stall
supports a diagnosis. If no dump or log exists, say "unverified risk" and name
the evidence needed.

An implementation node may apply the proposed remediation only inside its
authorized unit. A review node reports locations and fixes without editing.
Do not treat this skill as a new role, slot, or permission. The calling node's
role, sandbox and authorization remain authoritative; this method widens neither.

## Choose the path

- **Static risk audit** — source or diff is available, no dump. Read
  [static risk audit](references/static-risk-audit.md). A candidate is reported
  only after proving the executing thread, proving the call blocks, and
  attributing the owner; otherwise list it under dismissed with a reason.
- **Trace diagnosis** — an ANR trace or stack dump is supplied. Read
  [trace diagnosis](references/trace-diagnosis.md). Every conclusion must cite
  the trace; missing evidence is a gap, not a defect.

## Non-negotiable rules

1. **Prove the thread.** `viewModelScope`/`lifecycleScope` default to Main;
   executors, schedulers, handlers and Binder callbacks must be traced to their
   real dispatcher. Synchronously awaited Binder work counts as main-thread
   blocking. Do not infer "background" from a function name.
2. **Prove blocking.** Suspension (`suspend`, `delay`, coroutine `Mutex`) is not
   blocking. A seeded in-memory `StateFlow.value`, `BehaviorRelay` or replayed
   `SharedFlow` returns immediately. A single short sleep is a frame drop, not an
   ANR. Report a latent in-memory block only as `LOW`.
3. **Attribute the owner.** A blocking call whose implementation is chosen by an
   external callback/host belongs to that file, not to the file that invokes the
   interface. Report only defects originating in the reviewed unit or a concrete
   dependency that unconditionally blocks.
4. **Off-main View mutation is an ANR risk, not only a crash risk.** On
   Android 16 and older, concurrent `invalidate()`/`scheduleTraversals()` can
   leak a sync barrier and starve synchronous main-thread messages. Creating or
   configuring a detached View off-main is not this race; an attached View is.
5. **Never propose app fixes for an external bottleneck.** `EXTERNAL_BOTTLENECK`
   means the app is a passive victim; code changes would be speculative.

## Static severity

- `HIGH`: main-thread I/O or long wait on startup/lifecycle/input, or off-main
  mutation of an attached View.
- `MEDIUM`: main-thread blocking on a secondary path, or bounded work stalling
  for hundreds of milliseconds.
- `LOW`: latent in-memory blocking that does not block today, or Binder-thread
  blocking reached only from another process.

## Trace verdicts

Use the evidence order in `references/trace-diagnosis.md`:
`APP_DEFECT` → `APP_RESOURCE_OVERLOAD` → `EXTERNAL_BOTTLENECK`. Commit to one
primary verdict; record secondary contention as a contributing factor, never
"mixed". Check capture delay, process identity, foreground state and Android
version before interpreting stacks. `Debug Store` exists only on Android 15+;
its absence is not evidence.

## Output

For static work: one-line verdict (`ANR risk: yes (<severity>)` or `none found
in this file`), then findings with line range, thread proof/call chain, blocking
proof, severity and fix; then dismissed candidates with one-line reasons.

For trace work: process/trigger/unresponsive thread, user impact, capture
validity, system vitals, one verdict, root-cause mechanism, dependency chain,
secondary threads, remediation and prevention. If the verdict is external, both
remediation fields are `N/A — no application code change required`.

## Related

For Perfetto-wide attribution of a stall beyond an ANR dump, use
`android-performance-analysis`. For coroutine ownership and cancellation, use
`android-kotlin-concurrency`. Those methods do not replace an ANR dump.
