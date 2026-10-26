# Domain hints for Perfetto analysis

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  profilers/android-profiler/analysis/workflows/perfetto-trace-analysis/references/hints/
  hints_{cpu,graphics,memory,io,ipc,power}.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: merged and condensed; each hint still requires trace
evidence and a schema check. See ../../THIRD_PARTY_SOURCES.md.
-->

Hints suggest the next query. They never replace a timestamped result.

## CPU and scheduling

- For a long slice, inspect the thread's states: running, runnable, sleeping,
  uninterruptible. For latency, check whether the duration comes from long child
  slices; recurse.
- A wake-up followed by delay: check the CPU's IRQ track for a concurrent
  interrupt.
- Kernel hardware threads without real-time priority can be preempted.
- If the app package does not explain the stall, widen to all threads/processes:
  look for other runnable threads on the same CPU or high-priority kernel work.
- Check `cpu_frequency` for the cores that ran the victim. Missing transitions,
  no scaling, or a static low frequency during heavy compute suggests a governor
  bottleneck, not slow code. Query governor/ftrace events if available.
- For concurrency, find critical threads blocked in `D` and join scheduling data
  to identify the waker.
- Compare user vs kernel time; slices with a `[k]` prefix indicate kernel work.
- A long gap followed by a burst can indicate a catch-up storm.
- Quantify scheduling latency from the preceding Runnable interval
  (`preceding_sched_slice_for_thread`), including p95/p99 and maxima. If latency
  is high while other CPUs are idle, suspect placement/affinity.
- A large Runnable share means CPU contention; a large Running share with
  increased wall time at unchanged running percentage suggests lower frequency.

## Graphics, frames and GPU

- For UI jank, check long main-thread slices (for example measure/layout over
  roughly 8 ms) and whether they overlap the missed frame.
- Compare `actual_frame_timeline` with `expected_frame_timeline`; a deviation is
  missed/late frames.
- `bitmap_write_to_parcel` in milliseconds rather than microseconds: inspect
  child slices for `mmap` or unnecessary zeroing.
- Track `gpu_mem_total` per process for a high-level graphics-memory view.
- Largest graphics allocations: `android_graphics_allocs` by `size_bytes`;
  compare dimensions with display resolution.
- CPU+GPU double cost: a large graphics buffer plus a similar-sized CPU
  allocation (`rss_anon_bytes`/heap graph).
- Intermediate render targets: large buffers whose `usage_bits` lack
  `COMPOSER_OVERLAY`.
- Correlate `buffer_id` with SurfaceFlinger events to see whether a buffer was
  presented.
- Long `eglSwapBuffersWithDamageKHR` or buffer-swap slices suggest a large damage
  area; frequent/long `texture_upload` on the main thread is another cost.
- High `gpu_mem_total` spikes correlated with frame durations over vsync suggest
  memory-pressure jank.

## Memory and LMK

- `lmk_kill_occurred` bursts indicate severe pressure; correlate with processes
  consuming CPU in the same window.
- Inspect `anon_rss`, `swap_used`, `kswapd` CPU and PSI `memory_pressure`.
- For hardware-shared memory, query `dma_heap_stat`/`dmabuf_total_size` (or
  `ion_total_size` on older devices); RSS alone undercounts it.
- `RssFile` can overcount shared physical pages.
- For OOMs, compare current `mem.rss` with median/p95 history.
- Bitmap outliers: `android_bitmaps` dimensions, duplicate identical bitmaps,
  software bitmaps (CPU heap plus graphics memory).
- Retainer path to a GC root: `heap_graph_reference`; inspect app classes.

## I/O and uninterruptible sleep

- Long `D` state: check overlapping `verity` slices, `blocked_function` from
  `sched_blocked_reason`, and kworker runnable/blocking relationships.
- No `blocked_function`: look for a memory-lock holder (`jit-thread-pool`,
  memory-mapping work).
- Heavy `do_page_fault` during startup indicates I/O contention.
- Excessive small sequential `read()`/`pread()` on one fd indicates inefficient
  file I/O.
- `page_cache_readahead`: correlate wake times with
  `filemap_add_to_page_cache`; group by inode to find the file.
- `nr_sector` in `block_rq_issue` describes readahead size.
- If the cost disappears on later launches, it may be cold-start page-cache
  population, not a steady-state defect.

## IPC and binder

- Repeated similar outbound transactions from one process to multiple
  destinations in a short window indicate a binder storm/missing multiplexing.
- `binder_transaction`: group by `tid`, `service_name`, `method_name` for spam;
  group by `server_upid` to find the bottleneck server.
- Slow transaction: subtract `server_dur` from total `dur` to estimate time spent
  outside the server.
- Correlate a spammer's `tid` with `cpu_slice` for CPU cost, and
  `stack_profile_callsite` for the code path.
- Follow flow events (`flow.source_slice_id`/`dest_slice_id`) across processes.
- A long slice in one thread causally linked to a slice in another (for example
  `system_server` → SystemUI) indicates a scheduling/dependency bottleneck.
- A quick controlling-process binder call followed by a long receiver slice can
  be an asynchronous jank source.

## Power

- Sum rail energy (`power_ma × duration`) from `power_rails`; convert to a common
  unit such as mWh for comparison.
- `suspend_state`: little time suspended during screen-off indicates a
  wakefulness problem.
- Aggregate `kernel_wakelock` duration; `bt_`/`bcm` names may correlate with
  Bluetooth scan results.
- High modem rail: aggregate `network_packets` by UID; for shared UIDs use
  `socket_tag`.

## Cross-cutting guards

- A detected counter anomaly is a confound until it overlaps the symptom window
  and explains the measured delay.
- A single spike can be noise; check percentiles and repeated instances.
- Missing trace categories or dropped events limit the hint's applicability; tag
  the conclusion accordingly.
- Never infer an app-code defect from a hardware or scheduling signature alone.
