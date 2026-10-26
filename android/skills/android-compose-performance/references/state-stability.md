# State, snapshots and stability

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  jetpack-compose/jetpack-compose-performance/references/state-and-stability.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed, examples shortened, guidance preserved. See ../../THIRD_PARTY_SOURCES.md.
-->

Read when a composable reads rapidly changing state, derives state, or when
stability/skipping is proposed as a fix.

## 1. Defer reads to the latest phase

Compose runs Composition → Layout → Draw. A read in an earlier phase invalidates
more work than the same read later.

```kotlin
// Recomposes on every scroll pixel.
val offset = scrollState.value
Box(Modifier.offset(x = offset.dp))

// Reads in Layout; no Composition on scroll.
Box(Modifier.offset { IntOffset(scrollState.value, 0) })

// Reads in Draw; no Composition or Layout on each animation frame.
val alpha by animateFloatAsState(target)
Box(Modifier.graphicsLayer { this.alpha = alpha })
```

Pass a lambda provider (`() -> Float`) to a modifier when the read moves to
Layout or Draw; that phase deferral is what avoids recomposition. If a leaf
composable reads the lambda in its own Composition, the lambda still narrows the
read to that leaf — the leaf recomposes, its caller does not — but it defers no
phase, and the lambda is not free.

## 2. Backwards writes

A backwards write is a state write that follows a read of that state in an
earlier phase (Composition read → Layout/Draw write) or in a downstream scope of
the same pass. It schedules an earlier phase again and can cause a first-frame
flash, dropped frames, or an endless measure/draw loop.

```kotlin
// Backwards write: Composition reads height, Layout writes it.
var height by remember { mutableStateOf(0.dp) }
if (height > 100.dp) Banner()
Box(Modifier.onSizeChanged { height = it.height.dp })
```

Do not "fix" every assignment. `Write → Read` (write first, read later, or read
only in Draw after a Composition write) is not a backwards write. It may still be
**redundant state wrapping**:

```kotlin
var path by remember { mutableStateOf(Path()) }
path = viewModel.path()          // write before any read: not backwards
Canvas { drawPath(path, color) }
```

Prefer a plain `val` or read the value inside the target phase. Never write state
from `onSizeChanged`, `onPlaced` or a layout modifier when Composition reads it;
read measurements in Layout/Draw (`drawWithCache`, `Modifier.layout`) or hoist
window sizing instead.

## 3. Choose the derivation API

| Need | Use |
| --- | --- |
| Simple flag derived from fast-changing state | `computedStateOf` on Compose 1.13+, else `remember { derivedStateOf { } }` |
| Heavy calculation read several times per pass | `derivedStateOf` (multi-read cache can repay invalidation) |
| Trivial property lookup or inverted boolean | Plain Kotlin `get()` |
| One-shot async producer | `produceState`; not for synchronous derivations |

```kotlin
// Wrong: coroutine + flow dispatch for a synchronous boolean.
val atTop by produceState(true, scrollState) {
    snapshotFlow { scrollState.firstVisibleItemIndex == 0 }.collect { value = it }
}

// Compose 1.13+ (runtime 1.13.0-alpha03+):
val atTop by remember { computedStateOf { scrollState.firstVisibleItemIndex == 0 } }
// Compose < 1.13: remember { derivedStateOf { ... } }
```

`computedStateOf` re-runs the calculation on every read and does not cache it, so
it skips `derivedStateOf`'s cache bookkeeping for a trivial flag; readers are
invalidated only when the new result differs from the value last read, which is
why the default structural policy matters and `neverEqualPolicy` defeats it.
`derivedStateOf` caches and is better for expensive multi-read work. Neither
should wrap a raw `.size`/`isEmpty()` read. When using `derivedStateOf`, do not
pass the observed state values as `remember` keys; pass the `State` instance only
if the instance itself can change.

Version evidence (checked 2026-10-26): `computedStateOf` first appears in Compose
runtime 1.13.0-alpha03 and is absent from every 1.12.x plus 1.13.0-alpha01/02 —
see [ComputedState.kt](https://android.googlesource.com/platform/frameworks/support/+/refs/heads/androidx-main/compose/runtime/runtime/src/commonMain/kotlin/androidx/compose/runtime/ComputedState.kt)
and the [runtime API reference](https://developer.android.com/reference/kotlin/androidx/compose/runtime/package-summary).
At that date the newest published runtime was 1.13.0-beta02 and the newest stable
was 1.12.1, so a project on stable Compose still uses `derivedStateOf`.

## 4. Collections and repeated reads

- For whole-list replacement where element-level tracking is unnecessary, use a
  plain `MutableList` inside `mutableStateOf(list, neverEqualPolicy())` and make
  the assignment load-bearing:

```kotlin
private val backing = mutableListOf<Item>()
val items = mutableStateOf(backing, neverEqualPolicy())

fun add(item: Item) {
    backing.add(item)
    items.value = backing   // triggers recomposition
}
```

- Call `.toList()`/`.toSet()`/`.toMap()` once before repeated queries or
  iteration over a snapshot collection; each element read otherwise registers a
  fine-grained observation.
- Cache repeated `State` property reads in a local value; repeated reads create
  redundant snapshot lookups.
- Use `itemsIndexed` rather than `list.indexOf(item)` inside lazy item content.
- Avoid reading snapshot `State` in a custom setter; batch updates with a raw
  backing field.
- Explicit `remember` keys: pass every external value used by the calculation.
  Do not add keys that the block does not read.

## 5. Stability and strong skipping

Under strong skipping, unstable parameters still skip when the same instance is
passed (`===`). Stable parameters are compared with `.equals()`.

- A flat data class of `val` primitives/`String` in a Compose module is already
  inferred stable; adding `@Immutable` is redundant.
- Annotating a large collection model stable switches comparison from `O(1)`
  identity to `O(N)` structural equality. On every pass, a 3 ms deep `equals()`
  can cost more than executing a 0.2 ms composable.
- **Scope guard for existing annotations:** recommend removing `@Stable` /
  `@Immutable` only when the model feeds a lazy layout (`LazyColumn`, `LazyRow`,
  lazy grid, pager) **and** holds a large dataset or deep nested collections.
  Leave annotations on non-lazy or small/bounded models untouched.
- Do not recommend replacing `List<T>` with `ImmutableList<T>` or adding it to a
  stability config. Under strong skipping, standard lists compare by reference.
- Do not flag parameter unwrapping unless both caller and callee are skippable
  composables, the parent parameter uses structural equality, and the unwrapped
  property is an `ImmutableList`/forced-stable collection. Unwrapping a standard
  `List` costs nothing extra.
- Add `@Immutable` only when the compiler cannot infer stability (for example,
  types from non-Compose modules) and instances are recreated for unchanged data,
  the class is small/flat, and `.equals()` is trivial.

## 6. Measurement and misjudgement risks

- Recomposition count is not a performance metric. Once a pass is scheduled,
  skipping one child saves little; scheduling, state reads and expensive bodies
  dominate.
- Benchmark the user-visible operation on a release build (Macrobenchmark or a
  comparable frame measurement). A static change without a benchmark is a
  hypothesis.
- Method traces can show `Model.equals` dominating; that is evidence for the
  large-collection guard above, not a license to remove all annotations.
