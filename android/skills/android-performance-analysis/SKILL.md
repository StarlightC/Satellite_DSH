---
name: android-performance-analysis
description: Analyze an already supplied Android Perfetto trace with triage, PerfettoSQL, thread-state budgets, waker-chain attribution and evidence tags, without recording, downloading tools, installing binaries or claiming results from queries that were not run.
whenToUse: Load when a Perfetto trace path or supplied trace data is available and the task is jank, startup latency, ANR, memory pressure, binder stalls, scheduling or power attribution; do not use it to record a trace or set up profiling tools.
---

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  profilers/android-profiler/SKILL.md;
  profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/perfetto_trace_analysis.md;
  profilers/android-profiler/analysis/workflows/perfetto-sql/perfetto_sql.md (routing entry only);
  profilers/android-profiler/references/perfetto/sql.md (body of references/perfetto-sql.md);
  profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/triage.md;
  profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/per_candidate_analysis.md;
  profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/hints/hints_cpu.md (and hints_graphics/memory/io/ipc/power)
Attribution: Google / Android. Licensed Apache-2.0; see ../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: recording, orchestrator, setup, binary download and sub-agent fan-out removed; analysis knowledge retained. See ../THIRD_PARTY_SOURCES.md.
-->

# Android performance analysis

## Authority and limits

This skill performs **analysis only** on a trace or trace query results supplied
by the caller. It does not record a trace, start an emulator/device, download or
install `trace_processor`/Perfetto binaries, run an analysis orchestrator, spawn
sub-agents, or edit app code. If no trace or query surface is available, produce
the SQL and analysis plan, mark it unexecuted, and stop; do not invent numbers.

An implementation node may apply an evidence-backed fix only inside its
authorized unit. A review node reports findings and the missing evidence.
Measurement execution and the choice of environment belong to a validation node
and the user's approval, not this method. The calling node's role, sandbox and
authorization remain authoritative; this method widens neither.

## Inputs required

- A trace path or supplied trace data covering the symptom window.
- Device model, Android build, app/package, release/debug build state, and the
  workload or user journey.
- A baseline trace or an in-trace healthy instance when available.
- Knowledge of which atrace categories were enabled. Missing categories are a
  data gap, not a negative result.

A trace from a debuggable build, a different workload, or with dropped events
cannot support a performance claim without stating that limitation.

## Method

1. **Integrity first.** Check trace `stats` for dropped events, buffer overruns
   and CPU/data-loss indicators. Warn that findings may be incomplete and tag
   affected conclusions `[GAP]`.
2. **Triage system health.** Check thermal throttling, CPU frequency caps, LMK,
   memory pressure/PSI, binder volume and SurfaceFlinger/GPU state. Systemic
   confounds modify every app-side duration.
3. **Fix the symptom window.** Record start, duration and end. Expand upstream:
   a blocking event often begins hundreds of milliseconds before the visible
   jank. Follow the victim's first non-Running transition and its waker; if the
   origin is another process, record the expanded window and a co-candidate.
4. **Budget thread states.** Sum Running/Runnable/Sleeping/Uninterruptible (and
   the device's actual state labels) inside the window. Investigate every bucket
   above roughly 20%. Sleeping is benign unless a pending obligation (for
   example a binder reply) is outstanding; Runnable points to CPU contention or
   scheduling latency, not necessarily inefficient code.
5. **Follow the dependency chain.** For the dominant bucket, query what ran at
   entry/exit, then follow waker/server/lock chains across threads and processes.
   Every hop must explain the symptom; stop at a terminal physical bottleneck,
   software inefficiency, scheduling/platform limit, or external service stall.
   Unverified paths become partial suspects `[GAP]`, not conclusions.
6. **Apply domain hints.** Use `references/domain-hints.md` for
   CPU, graphics, memory, I/O, IPC and power patterns. Hints are diagnostic
   prompts, not evidence; verify each against the trace.
7. **Sweep confounds before attributing app code.** Check thermal/frequency,
   scheduler contention, cgroup quota, LMKD and other processes around the
   expanded window. A healthy app can look slow on a throttled device.
8. **Contextualize the workload.** Identify the user action or feature that
   triggered the window. A root cause without the triggering workload is not
   actionable.
9. **Tag every claim** `[SQL]` (backed by queried data), `[INFERRED]` (logical
   deduction), or `[GAP]` (missing/untraced). Report partial suspects even when
   a terminal cause was found.

## Verdict and report

Classify the primary finding as Hardware, Software/Code, System Exhaustion,
Scheduling Policy, or External Dependency. Include:

- candidate package/process/thread and UTID/UPID plus names;
- symptom and expanded window, expected budget if known;
- state-bucket budget and explained duration/percentage;
- dependency chain with thread names, IDs, blocking states and timestamps;
- evidence queries or data, and applied hints;
- confounds and partial suspects;
- recommended next step, with any app-code fix explicitly conditional on the
  classification.

If evidence is evenly split, report both suspicions with supporting data; do not
pick a winner by intuition.

## References

- [Triage and trace integrity](references/triage.md) — integrity queries,
  metrics, symptom-window definition and candidate output.
- [PerfettoSQL for analysis](references/perfetto-sql.md) — schema validation,
  table/module selection, safe intervals, joins and query pitfalls. Query
  execution is the caller's approved surface.
- [Dependency-chain analysis](references/dependency-chain.md) — state buckets,
  traversal matrix, output schema and evidence limits.
- [Domain hints](references/domain-hints.md) — CPU, graphics, memory, I/O, IPC
  and power patterns with misjudgement guards.

## Related

`android-anr-diagnostics` handles an ANR dump and its subject-specific
attribution. Use that method when the input is an ANR trace; use this method for
broader jank/startup/system analysis. Neither method turns a trace query into a
fix without the owning implementation node.
