# Static ANR risk audit

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  performance/anr-audit-and-fix/references/risk_analysis_guide.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed; proof and dismissal rules preserved. See ../../THIRD_PARTY_SOURCES.md.
-->

Goal: decide whether code in the reviewed file can stall the main thread (or a
Binder thread a caller waits on synchronously) long enough to cause an ANR, and
point to exact lines. A candidate becomes a finding only after steps 2, 3 and 5;
off-main View mutation uses step 4 plus step 5.

## Step 1 — List candidates

- Blocking primitives: `runBlocking`, blocking futures, latches, monitors,
  `Thread.sleep`, RxJava `blocking*`, locks shared with background work.
- Synchronous I/O or heavy compute: network, disk, database, `SharedPreferences
  .commit()`, `ContentResolver.query`, non-suspend DAO, bitmap decode, JSON/XML
  parsing, `MediaPlayer.prepare()`, unbounded loops.
- Synchronous IPC/lifecycle work: cross-process Binder/`ContentProvider`, heavy
  `Application`/`Activity`/`Service`/`Receiver`/provider callbacks.
- Off-main mutation of attached Views (step 4).

## Step 2 — Prove the executing thread

Inspect the enclosing dispatcher, scheduler, executor/handler, and Android
component callback. For a helper, trace one or two callers to establish the real
thread and state the verified chain.

- `lifecycleScope`/`viewModelScope` default to Main unless a different
  dispatcher is applied.
- `ContentProvider` queries run on a Binder thread cross-process, or the
  caller's thread in-process.
- A callback's thread is unknown until its dispatcher/executor is inspected.
- If you cannot show main-thread or synchronously awaited Binder execution,
  dismiss as "thread not established".

## Step 3 — Prove the call blocks

- Seeded in-memory reactive reads return immediately: `StateFlow.value`,
  `BehaviorRelay.getValue()`, `first()` on a populated replay≥1 `SharedFlow`.
- Suspension is not blocking: `suspend` functions, `delay`, coroutine
  `Mutex`/`Semaphore` suspend without holding the thread.
- `runBlocking` blocks only its calling thread. On a background thread it does
  not block Main unless Main waits on that thread.
- One bounded wait of tens to ~100 ms is a frame drop; do not report it as an
  ANR. A latent blocking primitive that completes in memory is `LOW`, with the
  change that would make it block.

## Step 4 — Attached-View threading (sync barrier leak)

An off-main mutation of an **attached** View is a `HIGH` ANR risk, not merely a
`CalledFromWrongThreadException` crash risk.

Mechanism: `ViewRootImpl.requestLayout()` calls `checkThread()`, but the
invalidation path (`invalidate()` → `onDescendantInvalidated()` →
`scheduleTraversals()`) reaches `scheduleTraversals()` without a thread check on
Android 16 and older (16 can opt into a check in `onDescendantInvalidated()` via
its `enableInvalidateCheckThread` flag). A background thread can then enter
`scheduleTraversals()` concurrently with Main; both post a sync barrier and
overwrite the unsynchronized `int mTraversalBarrier` token. `doTraversal()`
removes only one token, leaving an orphan sync barrier that starves synchronous
main-thread messages while VSYNC frames continue.

Android 17 (API 37) calls `checkThreadCompat()` first in `scheduleTraversals()`:
an off-main caller notifies registered `View.CalledFromWrongThreadListener`s and
then logs once per process, or throws once the
`ENFORCE_THREAD_CHECKS_ON_VIEW_ROOT_IMPL_APIS` compat change is enabled (its
`@EnabledSince` target is `CUR_DEVELOPMENT`, so the throw is opt-in). With the
`atomicTraversalBarrier` flag on, the token moves to an `AtomicLong` and a
clobbered barrier is removed instead of leaked; with the flag off the `int` field
and the leak remain, now logged. So on 17 the race is reported and conditionally
prevented, not unconditionally gone. A detached View created/configured off-main
does not trigger it.

Check for View/adapter mutations on `Dispatchers.Default`/`IO`, Rx background
schedulers, executors/threads, or worker-thread callbacks.

Detection (verified against the sources listed below, 2026-10-26):
- `View#registerCalledFromWrongThreadListener` — added in API level 37; compile
  with `compileSdk 37` and guard with `SDK_INT >= 37`. In AOSP it is
  `@FlaggedApi(called_from_wrong_thread_listener_api)`, so 37 is necessary but
  not sufficient: a 37 device booting with that flag off is not guaranteed to
  expose the method.
- `adb shell am compat enable ENFORCE_THREAD_CHECKS_ON_VIEW_ROOT_IMPL_APIS
  <package>` — ChangeId `464275874`; `am compat` resolves the name, so this turns
  the 17 throw on for one package (an approved test action on a debuggable build,
  not this skill).
- Robolectric `-Drobolectric.enforceViewMethodsCalledOnMainThread=true` — enables
  `ViewThreadChecker`, which fails the test when a View method runs off Main.

Sources: [View API reference](https://developer.android.com/reference/android/view/View)
("Added in API level 37"); [View.java, android17-release](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android17-release/core/java/android/view/View.java);
[ViewRootImpl.java, android17-release](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android17-release/core/java/android/view/ViewRootImpl.java)
and [android16-release](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/view/ViewRootImpl.java);
[view_flags.aconfig](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android17-release/core/java/android/view/flags/view_flags.aconfig);
[Robolectric ViewThreadChecker](https://robolectric.org/javadoc/4.17/org/robolectric/shadows/ViewThreadChecker.html).

Remediation at the root scope: keep in-memory UI reads/mutations on Main before
submitting background work, or configure the upstream callback/target to deliver
on Main. `withContext(Dispatchers.IO)` belongs only around slow work.

## Step 5 — Attribute and grade

Attribute to the file that owns the blocking statement or off-main mutation. If
the reviewed file invokes an abstract callback whose implementation blocks in an
external file, dismiss it here as owned by the caller/host.

- `HIGH`: main-thread I/O/long waits on primary paths, or attached-View
  mutation off-main.
- `MEDIUM`: main-thread blocking on secondary paths, or bounded work stalling
  for hundreds of milliseconds.
- `LOW`: latent hazards that complete in memory today, or Binder-thread blocking
  reached only externally.

## Reporting

Start with one verdict line. For each finding give line range, thread and
verified call chain, why it blocks (or why it leaks a sync barrier), severity and
fix. List dismissed candidates with a one-line reason: thread not established,
seeded relay, runs on IO through caller X, owned by caller, or bounded wait.

Static review never proves an ANR occurred. It proves a candidate in the reviewed
revision; the absence of a dump is a limitation, not a pass.
