# Effects, lifecycle and threading

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  jetpack-compose/jetpack-compose-performance/references/effects-and-threading.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed, examples reduced, API guidance preserved. See ../../THIRD_PARTY_SOURCES.md.
-->

Read when a composable starts work, registers a listener, collects a Flow, or
does expensive work in its body.

## 1. Keep composition pure

Composition and recomposition may run, be interrupted, or be discarded. A side
effect written directly in the body can therefore run more than once or for a
screen the user never sees.

```kotlin
// Wrong: runs on every composition attempt.
viewModel.trackImpression(userId)

// Synchronous, keyed publication after a successful composition.
SideEffect(userId) { viewModel.trackImpression(userId) }
```

`SideEffect(keys)` requires Compose runtime 1.12+: the key overloads first shipped
in 1.12.0-alpha02 and are absent from 1.11.x. On older versions, `SideEffect`
takes no keys; track the key with a remembered holder inside the effect rather
than inventing an empty `DisposableEffect`. Source:
[Effects.kt](https://android.googlesource.com/platform/frameworks/support/+/refs/heads/androidx-main/compose/runtime/runtime/src/commonMain/kotlin/androidx/compose/runtime/Effects.kt).

Never use `LaunchedEffect` for a synchronous call: it allocates and dispatches a
coroutine. Never use `DisposableEffect(keys) { ...; onDispose {} }` with an empty
dispose block as a keyed trigger.

## 2. Match the effect API to the work

| Work | API |
| --- | --- |
| Publish state or call a synchronous API after composition | `SideEffect` / keyed `SideEffect` |
| Register and unregister a listener, observer or resource | `DisposableEffect(keys)` with a real `onDispose` |
| Suspend, defer, or restart on a semantic key | `LaunchedEffect(keys)` |
| Start a coroutine from a click/gesture callback | `rememberCoroutineScope()` |
| Turn snapshot reads into a Flow | `snapshotFlow { }` collected inside `LaunchedEffect` |

Key an effect by the identity that should restart it. Do not use `Unit` to hide
a changing identity, and do not key on a broad state object when one property
controls the lifecycle. If a callback must stay current without restarting the
work, use `rememberUpdatedState` and read it lazily inside the effect.

```kotlin
val latestOnTimeout by rememberUpdatedState(onTimeout)
LaunchedEffect(Unit) {
    delay(1_000)
    latestOnTimeout()
}
```

Do not read that value eagerly inside `remember`, and do not use
`rememberUpdatedState(userId)` to avoid restarting collection that should follow
`userId`.

## 3. Execution order and teardown cost

When composition changes are applied, `DisposableEffect` runs first,
`SideEffect` second, and `LaunchedEffect` launches a coroutine asynchronously.
`LaunchedEffect` is not guaranteed to run after Layout/Draw; do not use it to
observe layout bounds.

Rough cost: `SideEffect` < `DisposableEffect` < `LaunchedEffect`. Cancelling a
`LaunchedEffect` tears down a coroutine job, so avoid cycling its keys during
animation or scrolling. Combine multiple effects that share a trigger into one
`LaunchedEffect` with nested `launch` blocks when they are genuinely independent.

## 4. Don't block the main thread

```kotlin
// Blocking disk read on the main dispatcher.
LaunchedEffect(fileUri) { state = parseJsonFromDisk(fileUri) }

// Offload; cancellation and lifecycle still belong to the effect.
val state by produceState<Data?>(null, fileUri) {
    value = withContext(Dispatchers.IO) { parseJsonFromDisk(fileUri) }
}
```

Keep business/network work in the screen state holder unless the UI owns the
keyed lifecycle. For a single blocking JVM call, `runInterruptible` can make
cancellation interrupt it; otherwise state the blocking API's cancellation
limitation. Do not claim that moving work to another dispatcher makes it
cancellable.

## 5. Long-lived effects and UI collection

- Use `collectAsStateWithLifecycle()` when a cold Flow, database observation,
  sensor, location or polling stream should stop while the screen is not
  started. It registers a lifecycle observer.
- `collectAsState()` can be appropriate for an in-memory `StateFlow` already
  scoped with `WhileSubscribed`; it avoids the observer overhead. Choose from the
  producer's lifecycle, not from a blanket rule.
- Hoist `BroadcastReceiver` and other system-listener registration to the screen
  level. Registering once per lazy item multiplies receivers and main-thread
  work.
- Guard optional effects with `if (callback != null)` instead of allocating an
  effect for a null callback.
- Replace `Handler.postDelayed`/`TimerTask` UI timers with `LaunchedEffect` +
  `delay()` so cancellation follows composition.

## 6. Lazy items and impressions

Lazy items are composed before they are visible. Do not fire impression
analytics or register receivers in `LaunchedEffect`/`DisposableEffect` inside an
item. Use `Modifier.onVisibilityChanged` with a dwell threshold instead, and
hoist a shared Flow collection above the lazy container.

## 7. Verification

The code check is structural: no side effect in the body, every effect has a
justified key and cleanup, and blocking work is off the main dispatcher. Runtime
proof still needs the project's own test or frame evidence. Do not present
"effect exists" as proof that it runs at the intended time.
