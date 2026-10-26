# Trace-driven ANR diagnosis

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  performance/anr-audit-and-fix/references/trace_analysis_guide.md and anr_trace_report_template.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed; evidence precedence and report fields preserved. See ../../THIRD_PARTY_SOURCES.md.
-->

Read only when a real ANR trace/stack dump is supplied. Cite timestamps, thread
states and frames; otherwise mark `[GAP]`.

## 1. Pre-flight validity

- **Process match:** the dumped process (`--- pid N at …`, `Cmd line:`) must match
  the ANR subject. `Input dispatching timed out` often has no package/PID; record
  `unknown` and do not abort.
- **Capture delay:** `Immediate` means the dump reflects the freeze. A large
  ANR-to-dump gap, or a `Debug Store` slow `LooperMsg` that completed just before
  the dump while Main is now idle in `nativePollOnce`, indicates a **Delayed
  Snapshot**. Do not call this bug-free or misclassify a completed slow
  transaction as a sync barrier leak.
- **Debug Store:** exists only on Android 15+. It logs `ActivityThread$H`
  messages slower than 2 seconds; receiver/service start-bind callbacks use
  separate tags, and generic `Handler.post` runnables are not logged. Its
  absence is not a signal.
- **User impact:** any `Input dispatching timed out`, or any component/service/
  job/startup ANR with `Foreground: Yes`, is user-perceived. Background
  component/watchdog ANRs with `Foreground: No` are silent background
  termination.

## 2. Attribute one verdict

Evaluate in order and stop at the first supported verdict. Record lower-ranked
contention as `Contributing Factor`; never output "mixed" or "shared".

1. **`APP_DEFECT`** — the unresponsive thread (`tid=1`; the `binder:` thread for
   provider ANRs; a custom-handler/`goAsync()` worker for receiver ANRs) has an
   app-side blocking dependency or contract violation:
   - direct I/O or heavy compute; synchronous in-process/cross-process wait
     (`Future.get()`, latch, SDK init, avoidable Binder call);
   - a lock/monitor/futex held by app work actively running on CPU, or a
     deadlock where the holder waits on a resource the victim owns;
   - a View-threading violation that leaked a sync barrier.
   This remains `APP_DEFECT` when app-driven CPU/GC/memory made the awaited work
   slow; put the overload in `Contributing Factor: APP (...)`.
   Distinguish `Blocked` on a lock from normal idle polling in
   `MessageQueue.nativePollOnce`.
   **Guard:** if the lock/GC holder is starved by real external saturation
   (run-queue wait, kernel I/O `state=D`) and the device is saturated, fall
   through. If CPU has headroom and the holder cannot run because the app gave it
   much lower priority than the victim, that priority inversion is app-created.
2. **`APP_RESOURCE_OVERLOAD`** — device CPU/memory/I/O is saturated or thrashing
   on major faults **and** the target app is a dominant driver (top CPU plus
   heavy faults, GC thrash, or hundreds of threads). If the app has low CPU share
   while `kswapd0`/other processes dominate, fall through to external.
3. **`EXTERNAL_BOTTLENECK`** — neither above: other processes/kernel saturate
   resources while the app has negligible/low CPU and no blocking app-side
   dependency (cold-start paging, disk wait, cgroup freezer). Propose **no** app
   code fix or defensive workaround.

## 3. Root-cause patterns

### Sync barrier leak vs indeterminate

When `tid=1` is in `nativePollOnce`, `dispatchVsync` or VSYNC rendering:

- All threads in kernel cgroup freezer → external starvation.
- `Debug Store` shows a completed slow `LooperMsg` covering the window, or dump
  capture is significantly delayed → `Indeterminate (Delayed Snapshot)` with the
  verdict supported by section 2.
- An unfinished async contract (`BroadcastReceiver.goAsync()` without
  `PendingResult.finish()`, `JobService` timeout, `SHORT_SERVICE` over deadline
  without `stopSelf()`) → `Async Lifecycle Timeout`. Claim only from trace
  records or a named subject; never infer it from an empty `Debug Store`.
- **Confirmed sync barrier leak:** background thread caught mutating views/
  `ViewRootImpl`, or Main actively rendering a VSYNC frame while a synchronous
  message starves alongside a spinning worker.
- **Probable:** the offending worker has exited. Require corroboration:
  immediate capture, Main in `nativePollOnce`/dispatching VSYNC, empty/absent
  `Debug Store`, no lock/IPC/`state=D` wait, plus VSYNC/context-switch or CPU
  evidence that async rendering continued while the synchronous message starved.
  Do not diagnose by elimination alone.

### Other patterns

- **Lock contention/deadlock:** identify the holder and diagnose the holder's
  work, not only the blocked victim. A priority inversion is app-owned.
- **Blocked/missing main thread:** if `tid=1` is absent from `DALVIK THREADS`,
  find it among `(not attached)` entries where `sysTid == PID` before concluding.
- **Stackless traces:** use `Waiting Channels` and `/proc` state. Kernel disk/
  filesystem wait with negligible app CPU → external; app threads in a `futex_*`
  convoy while the app burns CPU → app lock contention; app dominates CPU/faults
  without a futex convoy → app overload. ART's `Signal Catcher` normally waits in
  `sigtimedwait`; flag custom `SIGQUIT` interception only when an app thread also
  waits in a signal channel.
- **Compound threads:** scan for `state=D` fsync/fdatasync, third-party JNI/GC/
  signal hooks, custom signal waiters, unbounded pools and priority abuse.

## 4. Report

```
Overview: <APP_DEFECT | APP_RESOURCE_OVERLOAD | EXTERNAL_BOTTLENECK> (<diagnosis>)
1. Validity: process/PID, trigger subject, unresponsive thread, foreground,
   user-perceived yes/no, capture immediate/delayed.
2. System health: CPU %, iowait, PSI, faults, lock state; verdict and
   contributing factor.
3. Root cause: victim state/top frame, blocking chain or barrier mechanism,
   holder/waker, secondary threads, concise diagnosis label.
4. Remediation: concrete code fix and prevention for app verdicts;
   "N/A — no application code change required (external system bottleneck)"
   for external.
```

Tag every statement `[TRACE]`, `[INFERRED]` or `[GAP]`. An unrepresented thread
or missing interval stays a gap; it is not a pass.
