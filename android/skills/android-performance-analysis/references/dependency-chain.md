# Dependency-chain analysis

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/per_candidate_analysis.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: sub-agent fan-out removed; analysis protocol retained. See ../../THIRD_PARTY_SOURCES.md.
-->

Analyze one candidate at a time. Do not parallelize by spawning agents; keep the
evidence chain in one report so a reviewer can audit each hop.

## Guiding principles

1. **Validate schema first:** query `LIMIT 0` for every table/view before using
   its columns. Schemas evolve across trace-processor versions.
2. **Ground every claim:** cite timestamps, slice durations or counter values.
   Heuristics cannot replace trace data. If a query is empty, broaden the window
   or match strings fuzzily before concluding absence.
3. **Causation, not correlation:** a blocker must be active during the victim's
   wait interval. Concurrent busy work elsewhere is not automatically causal.
4. **Follow the chain until each hop explains the symptom:** cross thread,
   process and kernel boundaries; do not stop at an intermediate waker.
5. **Report uncertainty:** unverified paths are partial suspects tagged `[GAP]`.
6. **Sweep systemic confounds:** thermal throttling, CPU capping, scheduling and
   LMKD pressure can inflate wall-clock time without extra instructions.
7. **Contextualize the workload:** identify the user action/feature that
   triggered the window; a root cause without a workload is not actionable.

## 1. Baseline

- If an A/B baseline trace exists, query it first for expected slices, states and
  budgets.
- Otherwise find a healthy instance of the same operation earlier in the trace.
- If neither exists, tag the missing baseline `[GAP]` and proceed cautiously.

## 2. Time distribution

Sum the victim's thread states inside the symptom window. On Linux/Perfetto the
common states are Running, Runnable (`R`), Sleeping (`S`) and Uninterruptible
(`D`), but confirm the trace's actual labels.

Investigate every bucket at or above roughly 20% of the window, largest first.
Look for composite causes (for example 40% CPU-starved + 35% I/O-blocked).

- **Sleeping** is benign unless a pending obligation exists (binder reply,
  lock/futex, job completion).
- **Runnable** suggests CPU contention/scheduling latency; check frequency,
  throttling, core migration and runnable time before blaming code.
- **Uninterruptible** suggests I/O, page-cache/verity, memory reclaim or a kernel
  dependency; inspect `blocked_function`.
- **Running** can still be slow due to low frequency, slow core, IRQ/steal or
  inefficient code. Check frequency and scheduling.

For each significant bucket, query the slice/state at entry and exit. Tag
untraced or ambiguous segments `[GAP]`; do not guess.

## 3. Apply domain hints

Match the observed subsystem against [domain hints](domain-hints.md): CPU
scheduling/frequency, graphics/frames, memory/LMK, I/O, binder/IPC, power. Hints
are prompts for the next query, not proof. List which hints were applied.

## 4. Traverse to a terminal cause

Follow wakers, binder servers, lock holders and kernel threads. At each bucket,
conclude one of:

| Outcome | Action |
| --- | --- |
| Blocked by another thread | Continue traversal across the boundary |
| Terminal physical bottleneck | Stop; classify (thermal, GPU, storage/I/O) |
| Terminal software inefficiency | Stop; classify (main-thread I/O, allocation churn, excessive work) |
| Terminal scheduling/platform | Stop; classify (CPU quota, cgroup cap, foreground restriction) |
| Terminal external service stall | Stop; classify (`system_server` lock, SurfaceFlinger throttle) |
| Partial suspect | Stop; tag `[GAP]` and state what data would close it |

Before finalizing an app-code finding, run the systemic sweep around the expanded
window. Report confounds as co-root causes or duration modifiers.

## 5. Output

```
# Investigation result
Candidate: package / thread / classification
Symptom window: start–end (duration ms)
Expanded window: start–end (duration ms or "none")
Baseline: path or in-trace instance or [GAP]
Applied hints: ...

## Primary finding
Classification: Hardware | Software/Code | System Exhaustion |
                Scheduling Policy | External Dependency
Details and reasoning: ...
Explained duration: X ms (Y% of window)
Evidence: SQL/results with timestamps
Dependency chain: root → ... → leaf, with utid/upid/thread names/timestamps
Root cause: ...

## Other findings / partial suspects
Status, evidence and what remains unverified.

## Verification checklist
[ ] Claims tagged [SQL]/[INFERRED]/[GAP]
[ ] Explained duration covers the majority of the window
[ ] Unexplored buckets named with reasons
[ ] Workload contextualized
```

## 6. Misjudgement guards

- A long slice is not necessarily the cause; check whether the victim waited on
  it and whether its execution overlapped the wait.
- A waker that wakes the victim is not necessarily the blocker; follow the chain.
- An app thread busy during a stall may be a co-victim of the same external
  bottleneck.
- A single slow frame is not a trend; compare instances, percentiles or a
  baseline.
- Dropped events or missing categories limit every conclusion; state that before
  the verdict.
