# PerfettoSQL for analysis

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  profilers/android-profiler/references/perfetto/sql.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: session/setup/binary instructions removed; SQL guidance retained. See ../../THIRD_PARTY_SOURCES.md.
-->

This reference covers query construction only. Execute queries through the
caller's approved trace-query surface; this skill does not install, download or
launch profiler tooling. If no query surface is available, deliver the SQL and
mark the analysis unexecuted.

## 1. Discover the schema before querying

Schemas differ across trace-processor versions. Run a zero-row query first:

```sql
SELECT * FROM slice LIMIT 0;
SELECT * FROM thread_state LIMIT 0;
SELECT * FROM thread_or_process_slice LIMIT 0;
```

List available modules and their tables/functions; do not guess names:

```sql
SELECT package, module FROM __intrinsic_stdlib_modules ORDER BY 1, 2;

INCLUDE PERFETTO MODULE slices.with_context;
SELECT name, type, exposed, description
FROM __intrinsic_stdlib_tables('slices.with_context');

SELECT name, return_type, args
FROM __intrinsic_stdlib_functions('slices.with_context');
```

`__intrinsic_*` names are an implementation detail: use them during analysis,
but do not commit them into project scripts or dashboards.

## 2. Start with the standard library

| Question | Module | Main table |
| --- | --- | --- |
| Slices with thread/process names | `slices.with_context` | `thread_slice`, `process_slice`, `thread_or_process_slice` |
| CPU time of slices | `slices.cpu_time` | `thread_slice_cpu_time` |
| CPU time per thread/process | `sched.with_context` | `sched_with_thread_process` |
| Startup phases | `android.startup.startups`, `android.startup.startup_breakdowns` | `android_startups`, startup breakdown views |
| Frames/jank | `android.frames.timeline` | `android_frames` |
| ANRs | `android.anrs` | `android_anrs` |
| Binder | `android.binder` | `android_binder_txns`, `android_binder_metrics_by_process` |
| LMK/RSS | `android.memory.lmk`, `linux.memory.process` | `android_lmk_events`, `memory_rss_and_swap_per_process` |
| CPU frequency/clusters | `linux.cpu.frequency`, `android.cpu.cluster_type` | `cpu_frequency_counters`, `android_cpu_cluster_mapping` |
| Heap graph | `android.memory.heap_graph.dominator_tree`, `graphs.search` | `heap_graph_dominator_tree`, `graph_reachable_bfs!` |
| CPU samples | `stacks.cpu_profiling` | `cpu_profiling_samples` |
| Interval overlap | `intervals.intersect`, `intervals.overlap` | intersection/overlap macros |

If a query joins `slice → thread_track → thread → process` manually, first check
whether a stdlib module already exposes the result.

## 3. Joins, identifiers and time

- Join on `utid`/`upid`, never recycled `tid`/`pid`.
- IDs (`id`, `utid`, `upid`, `track_id`) are not stable across traces/runs. Use
  them inside a query, but report stable names alongside them.
- Slices with `dur = -1` are open at trace end; `dur = 0` are instant. Compute an
  effective end as `ts + IIF(dur = -1, trace_end() - ts, dur)`.
- Do not join adjacent events with `ts + dur = next.ts`; use stdlib interval
  modules that handle gaps and preemption.
- Filter on `ts` and `track_id` where possible; slice/counter tables have indexes
  on those columns.
- `EXPLAIN QUERY PLAN` before optimizing a slow query. Check whether an index is
  used rather than adding arithmetic.

```sql
-- Total time in a named slice group, safely handling open slices.
SELECT count(*) AS total_count,
       sum(IIF(s.dur = -1, trace_end() - s.ts, s.dur)) / 1e6 AS total_dur_ms
FROM slice AS s
WHERE s.name GLOB '*onMeasure*';
```

## 4. String and argument extraction

- Use `=` for exact matches.
- Use `GLOB` for substring/wildcard matches; `LIKE` is slower and treats `_` as a
  wildcard. For case-insensitive matching, lower both sides:
  `LOWER(name) GLOB '*renderthread*'`.
- Use `EXTRACT_ARG(arg_set_id, 'key')` for slice arguments instead of manually
  joining the args table.
- Use SQLite JSON functions such as `json_extract()` for JSON payloads.
- Prefix every column with its table/view alias.

## 5. Idempotent, materialized queries

Re-running an analysis should not fail on existing objects.

```sql
CREATE OR REPLACE PERFETTO TABLE my_slices AS
SELECT s.ts, s.dur, s.name, t.utid, p.upid
FROM slice AS s
JOIN thread_track AS tt ON tt.id = s.track_id
JOIN thread AS t ON t.utid = tt.utid
JOIN process AS p ON p.upid = t.upid
WHERE s.dur > 0;

DROP TABLE IF EXISTS my_span;
CREATE VIRTUAL TABLE my_span USING SPAN_JOIN(
  my_slices PARTITIONED utid,
  other_table PARTITIONED utid
);
```

- `CREATE OR REPLACE` works for Perfetto tables/views/macros/functions, not for
  SQLite virtual tables; drop those explicitly first.
- Materialize expensive intermediate results once; the caller's session may
  persist them across queries.
- `SPAN_JOIN` requires non-overlapping intervals within each input table and a
  `PARTITIONED` key. Intermediate inputs must be materialized tables, not views.
- `SPAN_JOIN` inputs with overlapping intervals crash the query; merge or
  partition first.

## 6. Overlap and CPU time

Use stdlib first. `slices.cpu_time` gives per-slice CPU execution without manual
scheduling joins. If no module applies, overlap between `[start1,end1)` and
`[start2,end2)` requires `start1 < end2 AND start2 < end1`; duration is
`MIN(end1,end2) - MAX(start1,start2)`, with open-slice ends made effective first.

For CPU frequency, include `linux.cpu.frequency` and use
`cpu_frequency_counters`; for cluster classification, include
`android.cpu.cluster_type`. Do not assume all cores ran at maximum.

## 7. Query pitfalls

| Symptom | Check |
| --- | --- |
| Empty result | Schema names, time unit, `dur` sign, string case; broaden a 100 ms window |
| Duplicate rows | Join cardinality, especially `thread_track`/`track` |
| Crash in `SPAN_JOIN` | Overlaps within an input, missing `PARTITIONED`, view instead of table |
| Slow query | Missing `ts`/`track_id` filter, no index, unnecessary `SELECT *`, manual join instead of stdlib |
| Wrong thread identity | Recycled `tid`/`pid`; use `utid`/`upid` and stable names |
| Totals exceed window | Open slices, overlapping tracks, or double-counted process/thread slices |

Report the final validated SQL with the findings so another engineer can rerun
it. State whether it was executed and on which trace revision; an unexecuted
query is a plan, not evidence.
