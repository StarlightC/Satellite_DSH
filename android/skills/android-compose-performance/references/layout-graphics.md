# Layout, drawing, animation and custom modifiers

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  jetpack-compose/jetpack-compose-performance/references/layouts.md,
  references/graphics-performance.md, references/animation.md,
  references/android/develop/ui/compose/custom-modifiers.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: four topics merged and condensed. See ../../THIRD_PARTY_SOURCES.md.
-->

## 1. Coordinates and visibility

`Modifier.onGloballyPositioned` can fire on every ancestor move, including every
scroll frame. Prefer targeted APIs:

| Need | API |
| --- | --- |
| Viewport fraction with optional dwell | `Modifier.onVisibilityChanged(minFractionVisible, minDurationMs)` |
| Width/height only | `Modifier.onSizeChanged` |
| Local placement after layout | `Modifier.onPlaced` |
| Window/root-relative bounds with throttle/debounce | `Modifier.onLayoutRectChanged` |
| Coordinates at event time inside a node | `requireLayoutCoordinates()` |

Do not cache coordinates into `MutableState` solely for a future click or
tooltip. In a `Modifier.Node`, query coordinates inside the pointer/draw handler.
In composable code, `Modifier.pointerInput { detectTapGestures { offset -> ... } }`
gives the tap offset directly; `Modifier.clickable` does not expose coordinates.

Never write state from `onSizeChanged`, `onPlaced` or a layout modifier when that
state is read in Composition. For sizing-dependent drawing, read in
`drawWithCache`; for placement, use `Modifier.layout`.

## 2. Phase deferral for layout and animation

```kotlin
// Layout phase, no Composition per offset tick.
Box(Modifier.offset { IntOffset(animatedX, 0) })

// Draw phase for alpha/scale/rotation/color.
Box(Modifier.graphicsLayer { alpha = animatedAlpha })

// Constraint animation without recomposing the subtree.
Box(Modifier.layout { measurable, constraints ->
    val width = animatedWidth
    val placeable = measurable.measure(constraints.copy(minWidth = width, maxWidth = width))
    layout(placeable.width, placeable.height) { placeable.placeRelative(0, 0) }
})
```

Inside a `LookaheadScope`, `animateBounds` can animate lookahead bounds without
recomposing content. For long lists, attach `sharedBounds`/`sharedElement` only
once an item is visible.

## 3. Layout tree and measurement cost

- Avoid a wrapper `Box` only to add background, border, padding or click; attach
  the modifier to the existing node.
- Avoid a `Canvas` composable for a decorative background; use
  `Modifier.drawBehind`/`drawWithCache`.
- `BoxWithConstraints`/`SubcomposeLayout` defer composition into measurement and
  can multiply work in lazy items. Use standard modifiers, `Modifier.layout`, or
  a `LayoutModifierNode` when constraints are enough.
- Intrinsic measurements run an extra measure pass. Use them only where siblings
  must match (for example, a divider matching text height) and avoid deep
  intrinsic chains.

## 4. Drawing allocations

`Canvas`/`drawBehind` can allocate a `Path`, `Paint` or `Brush` on every frame.
`drawWithCache` runs when size or keys change and can cache them:

```kotlin
Box(
    Modifier.fillMaxSize().drawWithCache {
        val path = Path().apply { moveTo(0f, 0f); lineTo(size.width, size.height) }
        onDrawBehind { drawPath(path, Color.Red) }
    },
)
```

For a `RuntimeShader`, parse and `remember` it outside the draw block; remember a
`ShaderBrush` keyed on the shader; set size-dependent uniforms in
`drawWithCache` and per-frame uniforms inside `onDrawBehind`.

Prefer `Path.rewind()` when rebuilding a path each frame with stable complexity;
use `reset()` when the path will not be reused or complexity shrinks sharply.

Avoid short-lived allocations in draw/measure/scroll loops:

- `Pair`/`Triple` for coordinates allocate and box primitives.
- `HashSet<Long>`/`HashSet<Int>` box keys; use `MutableLongSet`/`MutableIntSet`
  from `androidx.collection`.
- Standard `for (item in list)` allocates an iterator; use indexed loops or
  `fastForEach` in hot paths.
- `@JvmInline value class` boxes when used as a generic argument, nullable, or
  cast to `Any`. Prefer Compose's `Offset`, `IntOffset`, `IntSize` or
  `packFloats`/`packInts` utilities.

These are micro-optimizations. Apply them where a trace shows draw/measure or
allocation cost, not as a default rewrite.

## 5. Images

`painterResource` decodes synchronously during composition and has no awareness
of the display size; a small compressed asset can become a large bitmap and block
the main thread, including during lazy prefetch. Use an asynchronous loader that
downsamples to target bounds (for example Coil `AsyncImage`) for photos and large
bitmaps. Keep `painterResource` for vector drawables and small icons, or ship
pre-scaled thumbnails.

## 6. Custom modifiers

Prefer composing existing modifiers. `Modifier.composed` is no longer
recommended: composable modifier factories are never skipped, cannot be hoisted
out of composition, and resolve `CompositionLocal` at the factory call site.

Use `ModifierNodeElement` + `Modifier.Node`:

```kotlin
fun Modifier.circle(color: Color) = this then CircleElement(color)

private data class CircleElement(val color: Color) : ModifierNodeElement<CircleNode>() {
    override fun create() = CircleNode(color)
    override fun update(node: CircleNode) { node.color = color }
}

private class CircleNode(var color: Color) : DrawModifierNode, Modifier.Node() {
    override fun ContentDrawScope.draw() { drawCircle(color) }
}
```

- The element is immutable and allocated per pass; the node survives and is
  reused. Implement `equals`/`hashCode` (a data class does it) or `update` runs
  unnecessarily.
- Read `CompositionLocal` with `currentValueOf` in a
  `CompositionLocalConsumerModifierNode` to resolve at the usage site.
- Store a persistent `Animatable` on the node and launch it from `onAttach()`
  with the node's `coroutineScope`.
- Override `shouldAutoInvalidate = false` only when you can invalidate draw and
  layout selectively; otherwise keep the default.
