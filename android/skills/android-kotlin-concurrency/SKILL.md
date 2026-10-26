---
name: android-kotlin-concurrency
description: Review or design Kotlin coroutine ownership, cancellation, blocking boundaries, StateFlow/SharedFlow/Channel delivery, sharing and replay semantics, and one-shot event contracts without hiding work in stored scopes.
whenToUse: Load when a Kotlin change touches coroutine scopes, launch/async, runBlocking, StateFlow.value, SharedFlow replay, Channel events, stateIn/SharingStarted, or when cancellation and event-loss behavior must be decided.
---

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/kotlin-concurrency-and-flow/SKILL.md and references.
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: rewritten; gradle-run route removed; links redirected. See ../THIRD_PARTY_SOURCES.md.
-->

# Kotlin concurrency and Flow

## Authority and limits

Read-only design/review guidance. This skill does not run Gradle, tests, or
device commands; a validation node owns execution. An implementation node may
edit only the authorized unit. No permission means no code change and no claimed
runtime result. The calling node's role, sandbox and authorization remain
authoritative; this method widens neither.

## Core principle

Give every asynchronous operation a visible owner and lifetime, then choose state
and event primitives whose replay, fan-out, buffer and synchronous-read behavior
match the product contract.

## Procedure

1. Name each coroutine owner, cancellation boundary, producer, consumer, durable
   state and transient event.
2. If a `suspend` API already gives the caller ownership of cancellation, result
   and failure, finish with no change. Do not add a scope, `launch`, callback or
   `Deferred` wrapper just to make the API non-suspending.
3. Move work to a scope whose lifecycle owns it. Do not store or inject an
   arbitrary `CoroutineScope` in repositories, managers, use cases or data
   sources. A cancelled stored scope makes later launches silently do nothing.
4. Constructors and `Initializer.initialize()` may register, but must not launch.
   Use an explicit suspending bootstrap or one named launch site.
5. Keep a non-suspending launch only at a UI/state-holder boundary, where the
   class owns UI state, the scope is cancelled with that surface
   (`viewModelScope`, component scope, remembered Compose scope), and the caller
   is a real UI event or lifecycle hook. Lower layers stay suspending.
6. Model renderable current data as state. Use an event only when loss and replay
   are explicitly acceptable. Decide whether each element needs at most one
   receiver, with no delivery guarantee (`Channel`, buffered, `receiveAsFlow()`),
   or every active consumer must receive it (deliberately configured
   `SharedFlow`). If the consumer contract is unknown, stop and state the
   decision needed.
7. Preserve `CancellationException` through broad `catch` and `runCatching`.
   `currentCoroutineContext().ensureActive()` or a terminal `getOrThrow()` keeps
   cancellation from becoming success.
8. Choose blocking boundaries deliberately: `runBlocking` only at a true
   blocking edge (CLI `main`, required synchronous framework bridge, migration
   shim); `runTest` in tests. Moving blocking work to a dispatcher changes where
   it runs, not whether cancellation interrupts it; use `runInterruptible` for a
   single interruptible JVM call and state any remaining limitation.
9. Finish when a reader can locate the owner, start, cancellation, restart,
   replay and failure behavior from the public API without guessing.

## Scope and launch choices

| Situation | Action |
| --- | --- |
| Repository/manager/use case/data source needs async work | Expose `suspend`; caller chooses scope and error handling |
| UI callback reaches a UI state holder | Holder may launch on its lifecycle scope |
| Background reaction has an observable coroutine-owning consumer | Suspend at the consumer's mutation/collection site |
| Periodic or deferred work | Enqueue from a suspending orchestrator |
| Synchronous external API has no observable lifecycle | One named launch site, never a class `init` |
| Lifecycle infrastructure explicitly owns cancellation/errors/restart | It may own a scope, but exposes visible start/stop |

```kotlin
class FavouritesViewModel(private val repository: FavouritesRepository) : ViewModel() {
    fun onToggle(item: Item) {
        viewModelScope.launch { repository.toggle(item) }
    }
}
```

The UI exception requires all three conditions above; it is not a loophole for
launching anywhere.

## References

- [Structured concurrency](references/structured-concurrency.md) — scope
  ownership, cancellation, blocking boundaries and incremental refactor.
- [Flow state and events](references/flow-state-events.md) — `StateFlow`,
  `SharedFlow`, `Channel`, `stateIn`, replay, buffering and one-shot delivery.

## Related

- [Compose state and effects](../android-compose-state-effects/SKILL.md) for UI
  collection and effect lifecycle.
- [Compose UI testing](../android-compose-ui-testing/SKILL.md) for test seams;
  concurrency tests still belong to the project's test plan.
