---
name: android-compose-performance
description: Diagnose and reduce Jetpack Compose recomposition, layout, draw, lazy-list, animation and effect-threading cost from code and frame evidence, without treating recomposition counts or static guesses as a benchmark.
whenToUse: Load when a Compose change or investigation reports jank, slow scrolling, animation hitches, repeated recomposition, or suspected measure/draw overhead; read the matching reference before proposing an edit.
---

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  jetpack-compose/jetpack-compose-performance/SKILL.md and its references.
Attribution: Google / Android. Licensed Apache-2.0; see LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed, reorganized, links adjusted. See THIRD_PARTY_SOURCES.md.
-->

# Compose performance

## Authority and limits

This is a read-only diagnostic method. It may propose code changes, but it does
not edit outside an implementation node's authorized unit, does not run Gradle,
build, profile or device commands, and does not turn a code reading into a
measured result. A caller that needs measurement must supply release-build frame
or trace evidence from an approved validation path; otherwise report the gap.

Static review can identify a likely cost, not prove a frame drop. Keep
"candidate", "measured" and "unverified" separate in every report. The
calling node's role, sandbox and authorization remain authoritative; this
method widens neither.

## Preconditions before optimizing

1. Profile only a **release** build. Debuggable builds add ART verification and
   invalidate timing comparisons.
2. Keep R8 enabled and verify critical journeys have a baseline profile; missing
   profiles are a startup/jank cause, not a composable micro-issue.
3. Record the Compose version from version catalogs before recommending
   `computedStateOf` (runtime 1.13+), keyed `SideEffect` (runtime 1.12+), or
   other version-gated APIs.
4. Fix the symptom, screen and workload first. "Recomposition is high" is not a
   symptom; dropped frames, slow scroll, delayed input or animation hitch is.

## Audit workflow

1. Read the target composables, modifier chains and lazy data models at the
   declared revision.
2. Scan all seven categories below rather than stopping at the first finding.
3. Before flagging or editing a category, open its linked reference and apply
   its scope guard. The summary here is a router, not the full rule.
4. Prefer the smallest change that addresses the measured or strongly bounded
   cause. Do not add stability annotations, `ImmutableList`, or extra state as a
   default fix.
5. For implementation, change only the authorized files. For review, report
   location, evidence and the check that would confirm the effect; do not edit.

## Category checklist

1. **State, snapshots and stability.** Defer fast-changing reads with lambda
   modifiers (`Modifier.offset { }`, `graphicsLayer { }`). Never write state
   after reading it in the same pass (backwards write). Replace synchronous
   `produceState + snapshotFlow` derivations with `computedStateOf` (runtime
   1.13+) or `remember { derivedStateOf { } }`. Do not force stability on large
   collections: under strong skipping, an unchanged standard `List` skips by
   `===`, while `@Immutable`/`ImmutableList` can add `O(N)` `equals()`.
   Read `references/state-stability.md` before changing this category.
2. **Layout and measurement.** Replace `onGloballyPositioned` state caching with
   `onVisibilityChanged`, `onPlaced`, `onLayoutRectChanged`, or on-demand
   `requireLayoutCoordinates()`. Avoid decorative wrappers, `Canvas` nodes,
   `BoxWithConstraints`/subcomposition in hot or lazy items, and deep intrinsic
   chains. Read `references/layout-graphics.md` before changing this category.
3. **Lazy layouts.** Use stable primitive `key` and `contentType` for every
   item; use `itemsIndexed` instead of `indexOf`; track selection in a `Set` or
   `SnapshotStateSet`; pass `isSelected: () -> Boolean` to leaf items; hoist
   shared flows and `CompositionLocal` reads out of item scopes. These rules
   apply only to virtualized containers. Read `references/lazy-layouts.md` before changing this category.
4. **Animation and shared transitions.** Read animated alpha/scale/rotation in
   `graphicsLayer`, offsets in `offset { }`, size in layout/lookahead; attach
   `sharedBounds`/`sharedElement` only when an item is visible in long lists.
   See the animation section in `references/layout-graphics.md` before changing this category.
5. **Effects and threading.** No side effects in the composable body. Use
   `SideEffect` for synchronous keyed work, `DisposableEffect` only with real
   cleanup, `LaunchedEffect` for suspending work. Offload blocking I/O with
   `withContext(Dispatchers.IO)`; use `rememberUpdatedState` for callbacks read
   by long-lived effects. Read `references/effects-threading.md` before changing this category.
6. **Drawing and graphics.** Cache `Path`, `Paint`, `Brush` and size-dependent
   shader uniforms in `drawWithCache`; keep per-frame uniforms in the draw block;
   prefer `Path.rewind()` in stable-complexity hot loops; load bitmaps with an
   asynchronous, downsampling image loader rather than `painterResource` in
   scrolling content. Read `references/layout-graphics.md` before changing this category.
7. **Custom modifiers.** Prefer chaining existing modifiers. When custom
   behavior is required, migrate `Modifier.composed` to `ModifierNodeElement` +
   `Modifier.Node` (or `DelegatingNode`), implement `equals`/`hashCode` on the
   element, and query coordinates on demand. See
   `references/layout-graphics.md` before changing this category.

## False-positive guards

- A state assignment before any read is **not** a backwards write; it is at
  most redundant state wrapping. A backwards write requires read-before-write.
- A lambda provider has two different benefits; do not conflate them. Deferring
  the read to Layout or Draw avoids recomposition. Passing it to a child that
  reads it in its own Composition only narrows *which* scope recomposes (the leaf
  instead of the caller) — that leaf still recomposes on every change.
- `@Stable`/`@Immutable` on a small flat model is not automatically wrong.
  Recommend removal only for large/deep models feeding a lazy layout.
- Do not flag a standard `Column`/`Row` loop for missing lazy `key` or
  `contentType`; those parameters are lazy-container concepts.
- A skipped composable is not free: parameter slot storage and equality checks
  still run. Optimize the work, not the skip count.
- `collectAsStateWithLifecycle` reduces background work but has lifecycle
  observer overhead; `collectAsState` can be appropriate for in-memory
  `StateFlow` already scoped with `WhileSubscribed`.
- A `LaunchedEffect(Unit)` that reads a changing callback is a stale-capture
  bug, not automatically a key that should restart the effect.

## Measurement and reporting

Use Macrobenchmark frame timing, Perfetto/jank evidence, or a documented
before/after release measurement. Recomposition counts alone, debug builds, and
single-run timings are not sufficient. If only code inspection was possible,
say so, name the untested device/API level, and list the measurement that would
confirm the change. For trace work, use `android-performance-analysis` rather
than inventing frame conclusions.

## References

- [State and stability](references/state-stability.md)
- [Effects and threading](references/effects-threading.md)
- [Lazy layouts](references/lazy-layouts.md)
- [Layout, draw and modifiers](references/layout-graphics.md)
