# Local Compose state

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/compose-state-and-effects/references/local-state.md
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed; examples extended with saveability limits. See ../../THIRD_PARTY_SOURCES.md.
-->

## Core principle

Mutable local UI state must survive recomposition and notify Compose when it
changes.

## Procedure

1. In a composable scope, use `remember { mutableStateOf(...) }`. A bare local
   `var` resets on every recomposition and does not invalidate UI.
2. Use `rememberSaveable` when the value must survive configuration change or
   process recreation. Only save values a `Bundle` can hold (primitives,
   `String`, `Parcelable`, `Serializable`, or a custom `Saver`). Do not save
   lambdas, runtime objects or a whole ViewModel.
3. For in-place observable collection changes, use `mutableStateListOf` /
   `mutableStateMapOf`. With `mutableStateOf(List)`, replace the list instead of
   mutating it; otherwise Compose cannot see the change.
4. Do not mutate snapshot state from the composable body to rebuild derived data.
   Use `remember(keys) { ... }` for a read-only result; events and effects own
   mutations.
5. Prefer `rememberSaveable` over retaining a navigation argument or ID in a
   custom singleton. If the value is already durable in the state holder, do not
   duplicate it locally.

```kotlin
@Composable
fun Counter() {
    var count by rememberSaveable { mutableStateOf(0) }
    Button(onClick = { count++ }) { Text("$count") }
}
```

```kotlin
// Read-only derivation; no composition-time write.
val merged = remember(parent, overlay) {
    if (overlay.isEmpty()) parent else parent + overlay
}
```

## Exceptions and boundaries

- A local `var` inside `remember`'s producer, in a non-composable callback, or in
  a plain helper is ordinary Kotlin state and is not a Compose-state defect.
- Tests using `setContent` are composable scopes and follow the same rules.
- `produceState` already owns a coroutine producer; do not add an inner
  `LaunchedEffect` just to produce it.
- `rememberUpdatedState` is effect-capture state, not a replacement for ordinary
  local UI state.
- For state shared with siblings, hoist it; for state produced by business logic,
  move it to the screen holder. See [state hoisting](state-hoisting.md).

## Risks

- `remember` without keys can return a stale derived value after inputs change.
  Pass every external input used by the calculation as a key.
- Saving a mutable object that is later mutated in place defeats
  `rememberSaveable`; save an immutable snapshot or a stable ID.
- Reading and writing the same state in the body can create a recomposition loop;
  moves writes to events/effects.
