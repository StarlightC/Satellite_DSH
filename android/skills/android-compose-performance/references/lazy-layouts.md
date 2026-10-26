# Lazy layouts

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  jetpack-compose/jetpack-compose-performance/references/lazy-layouts.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed, examples shortened, scope guard retained. See ../../THIRD_PARTY_SOURCES.md.
-->

**Scope:** these rules apply to virtualized containers (`LazyColumn`,
`LazyRow`, lazy grids, pagers), not to ordinary `Column`/`Row` loops.

## 1. Stable keys and content types

```kotlin
LazyColumn {
    items(
        items = feed,
        key = { it.id },
        contentType = { it.type },
    ) { item -> FeedRow(item) }
}
```

- A stable key preserves item state across insert, remove and reorder.
- `contentType` lets Compose reuse slots and composition for visually equivalent
  items while scrolling.
- Keys must survive process death because lazy layout state uses
  `rememberSaveable`. Prefer `Int`/`Long`; combine fields into a `String` only if
  needed. Do not use `hashCode()` or list indexes; they change on reorder.
- Do not omit `contentType` when a feed has heterogeneous row types.

## 2. Avoid per-item searches and broad reads

- Replace `list.indexOf(item)` with `itemsIndexed`; an index lookup inside every
  item makes layout `O(N²)` and can throw during asynchronous mutation.
- Track selection with `Set<String>` in `mutableStateOf` or
  `SnapshotStateSet` (`mutableStateSetOf`). `SnapshotStateList.contains` is a
  linear scan.
- A read in the outer `items { }` scope subscribes the whole list/section to
  that state. Defer the read to the leaf:

```kotlin
items(topics, key = { it.id }) { topic ->
    TopicChip(
        topic = topic,
        isSelected = { selectedIds.contains(topic.id) }, // read in leaf
        onToggle = {
            selectedIds = if (topic.id in selectedIds) {
                selectedIds - topic.id
            } else {
                selectedIds + topic.id
            }
        },
    )
}
```

- Do not wrap a direct `size`/`isEmpty()` read in `derivedStateOf`; the wrapper
  costs more than the property read.

## 3. Prefer eager layout for small bounded collections

For roughly 1–10 static or bounded items (chips, tags, form rows), a normal
`Row`/`Column` with `forEach` avoids lazy measurement and prefetch machinery.
Benchmark before changing large or dynamic feeds; virtualization exists for
them.

## 4. Hoist shared subscriptions and locals

- Collect a shared `Flow` once above the lazy container, then pass stable values
  or lambda providers down. Collecting per item creates one subscription per
  visible item and recomposes all of them on each emission.
- Read `LocalContext`, `LocalDensity`, transition scopes and similar values once
  in the parent and pass resolved values. Reading a `CompositionLocal` in every
  item adds lookup and subscription cost.

## 5. Shared transitions and effects

- Attach `Modifier.sharedBounds`/`sharedElement` only when an item is visible
  (for example behind `Modifier.onVisibilityChanged`); pre-fetched items would
  otherwise instantiate transition tracking they never display.
- Do not log impressions from `LaunchedEffect` inside items; items are composed
  before visibility. Use `onVisibilityChanged` with a dwell threshold.
- Avoid `BoxWithConstraints` inside lazy items; it adds subcomposition per
  recycled/prefetched item. Prefer `Modifier.layout` or a layout node.

## 6. Misjudgement risks

- A `key` alone does not fix a slow item body; keys prevent identity churn, not
  expensive composition.
- `contentType` is a reuse hint, not a correctness boundary. Items with the same
  content type must be interchangeable at the slot level.
- `LazyColumn` is not automatically faster for a three-row static form; measure
  or bound the collection size before recommending either direction.
- A selection `Set` still triggers recomposition of readers. The lambda provider
  isolates the read, but an unchanged set should not be recreated each pass.
