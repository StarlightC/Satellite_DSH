# Triage and trace integrity

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/triage.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: setup/session commands removed; integrity, metrics and window rules kept. See ../../THIRD_PARTY_SOURCES.md.
-->

Use this pass before naming any bottleneck. It establishes whether the trace can
answer the question and which time window matters.

## 1. Verify data integrity

Read the `stats` table and check dropped events, buffer overruns, CPU loss and
trace truncation. Confirm the schema rather than assuming columns:

```sql
SELECT * FROM stats LIMIT 0;
SELECT name, value, severity
FROM stats
WHERE severity != 'info'
ORDER BY severity;
```

If events were dropped, say so before any conclusion and tag affected claims
`[GAP]`. A short/empty result is not evidence that a cost did not occur.

## 2. Run high-level system metrics

If the caller's approved query surface exposes metric passes, request the
relevant names rather than writing a custom approximation:

`android_startup`, `android_cpu`, `android_mem`, `android_lmk`,
`android_binder`, `android_surfaceflinger`, `android_gpu`.

Check thermal throttling, CPU frequency caps, LMKD kills, memory/PSI pressure,
binder contention and SurfaceFlinger/GPU state. Report only detected issues.

Useful tables by symptom (confirm columns with `LIMIT 0`):

| Symptom | Primary tables |
| --- | --- |
| App startup | `android.startup.startups` (`android_startups`), `slice` |
| App jank | `actual_frame_timeline_slice`, `slice`, `thread_state` |
| System jank | `actual_frame_timeline_slice`, `slice`, SurfaceFlinger slices |
| Crash | `slice` (crashed/tombstoned), `process` |
| ANR | `thread_state`, `slice`, ANR dump when supplied |
| Frame timing | `DrawFrame`/`doFrame` slices, `actual_frame_timeline_slice` |
| Memory pressure/LMK | `counter`, `sched_slice`, LMK events |

## 3. Define and expand the symptom window

1. Record start (`ts`), duration (`dur`) and end (`ts + dur`) of the specific
   user-visible issue.
2. Expand upstream: find the victim's first non-Running state transition in the
   window and follow its waker. If the blocking event begins before the window,
   extend the start to that origin and note the expanded window.
3. If the chain reaches another process (a binder server, `system_server`,
   SurfaceFlinger, a kernel worker), record that upstream stall as a
   co-candidate rather than treating it as the whole cause.

```sql
INCLUDE PERFETTO MODULE slices.with_context;

-- Longest slices in the candidate window; replace bounds with real values.
SELECT ts, dur, name, thread_name, process_name, utid, upid
FROM thread_or_process_slice
WHERE ts < 1_200_000_000 AND ts + dur > 1_000_000_000
ORDER BY dur DESC
LIMIT 50;
```

Timestamps above are illustrative. Use the trace's actual nanosecond bounds and
check `dur = -1` for still-open slices.

## 4. Produce candidates

For each candidate record:

- issue classification (startup, jank, ANR input, crash, memory pressure);
- package, process, thread, `upid`, target `utid`, RenderThread `utid` for jank;
- symptom window and expanded window in milliseconds;
- severity note (for example, "150 ms missed frame, worst instance");
- a one-line reason it is a candidate, not a conclusion.

If nothing is found, ask for a more specific timestamp/symptom or state that the
trace lacks the required category. "No candidate" without checking the window
and categories is not a result.

## 5. Triage risks

- A high `Running` duration is not automatically inefficient code; check
  frequency, core placement and scheduling.
- A sleeping victim may be waiting on a binder reply or lock; sleeping is not
  benign by itself.
- A system metric anomaly is a confound until it overlaps the symptom window and
  explains the delay.
- Do not compare traces from different builds, workloads, devices or trace
  configurations as if they were an A/B baseline.
