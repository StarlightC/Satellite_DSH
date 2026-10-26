# Compose side effects

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/compose-state-and-effects/references/side-effects.md
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed; examples kept with corrected imports note. See ../../THIRD_PARTY_SOURCES.md.
-->

## Core principle

Composable bodies render; external work belongs to the smallest effect whose
lifecycle matches that work.

## Procedure

1. Choose the effect from the table. Keep network/business work in the
   appropriate screen holder unless the UI itself owns the keyed lifecycle.
2. Key an effect by the semantic input that should restart or dispose it. Do not
   use `Unit` to hide a changing identity, or a broad state object when one
   property owns the lifecycle.
3. For a long-lived effect that needs the latest callback without restarting,
   read a `rememberUpdatedState` value lazily inside the effect or a later
   callback. If a changed value should recreate work, key it instead.
4. Collect event/side-effect flows in `LaunchedEffect`; collect render state near
   the state holder and render it as plain state. A `snapshotFlow` needs a
   terminal `collect`.
5. Pair every registration in `DisposableEffect` with `onDispose`. Start
   click/gesture coroutines through `rememberCoroutineScope`, not an event flag.
6. Finish when work cannot run from composition, its restart/cleanup identity is
   explicit, and the current lifecycle owns cancellation.

| Need | API |
| --- | --- |
| Publish Compose state after successful recomposition | `SideEffect` |
| Register/unregister a listener or resource | `DisposableEffect(keys...)` |
| Suspending, deferred or keyed work | `LaunchedEffect(keys...)` |
| Suspend work caused by a user event | `rememberCoroutineScope()` |
| Turn snapshot reads into a Flow | `snapshotFlow { ... }` in `LaunchedEffect` |

```kotlin
import androidx.compose.runtime.getValue // required by `by`
import androidx.compose.runtime.rememberUpdatedState

val latestOnTimeout by rememberUpdatedState(onTimeout)
LaunchedEffect(Unit) {
    delay(1_000)
    latestOnTimeout()
}
```

Do not read `latestOnTimeout` eagerly in `remember { ... }`; that captures the
initial value. Either key `remember` on the changing value or defer the read in a
lambda. Do not use `rememberUpdatedState(userId)` to avoid restarting a
collection that should follow `userId`.

```kotlin
DisposableEffect(owner, observer) {
    owner.lifecycle.addObserver(observer)
    onDispose { owner.lifecycle.removeObserver(observer) }
}
```

## Effect choice details

- `SideEffect` runs after every successful recomposition. For one-shot keyed
  work, use keyed `SideEffect` (Compose runtime 1.12+; the key overloads were
  added in 1.12.0-alpha02) or a keyed `LaunchedEffect`.
- `DisposableEffect` runs synchronously when composition changes are applied and
  on key change/exit. An empty `onDispose` is not a substitute for `SideEffect`.
- `LaunchedEffect` launches asynchronously on the composition context; it is not
  guaranteed to run after Layout/Draw.
- `snapshotFlow` is cold until collected. Collect it in an effect, not in the
  composable body.
- Use lifecycle-aware state collection on Android where available; for
  in-memory/`WhileSubscribed` state, plain `collectAsState` can be appropriate.

## Exceptions

- A side effect in a non-composable callback (for example a click handler) is
  ordinary imperative code and does not need an effect wrapper.
- `SideEffect` is not for suspend work; use `LaunchedEffect` or a
  `rememberCoroutineScope` launched from the event.
- For focus-derived side work, use a keyed effect or `snapshotFlow`, never an
  `if` in the composable body. Focus graph and keyboard semantics are outside
  this reference; do not invent focus APIs here.

## Risks

- Changing `LaunchedEffect` keys during animation or scrolling repeatedly
  cancels and relaunches coroutines. Prefer `rememberUpdatedState` when the
  lifecycle should not restart.
- Collecting a shared Flow per lazy item multiplies subscriptions; hoist it.
- Registering a receiver/listener per item leaks and re-registers on every
  composition. Hoist to the screen and unregister in `onDispose`.
