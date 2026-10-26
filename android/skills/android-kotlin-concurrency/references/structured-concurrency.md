# Structured concurrency

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/kotlin-concurrency-and-flow/references/structured-concurrency.md
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed; examples kept technically equivalent. See ../../THIRD_PARTY_SOURCES.md.
-->

## Core principle

Asynchronous work should have a visible entry, exit, owner and lifetime. Most
repositories, managers, use cases and data sources should expose `suspend` APIs
rather than retain a `CoroutineScope`.

## Review procedure

1. Name the caller that owns cancellation, completion and failure. If none is
   visible, do not add or keep a launch.
2. Treat raw `Thread.start` or `Executor.execute`/`submit` as detached work when
   no caller can observe completion, cancellation and failure. Expose a suspending
   API and let the lifecycle owner launch it; do not pass a `CoroutineScope` into
   a lower layer merely to replace the thread.
3. An executor is not automatically a defect: it may back a `CoroutineDispatcher`
   or a required thread-affinity adapter. Verify an explicit owner closes/stops it
   and completion/failure remain observable.
4. Replace a stored, injected, lazily-created or function-local scope on a
   non-UI class with suspending APIs. A cancelled stored scope makes later
   launches silently do nothing.
5. Move constructor/initializer launches to an explicit suspending bootstrap or
   named launch site.
6. Keep a non-suspending launch only at the UI/state-holder boundary below.
7. Re-throw `CancellationException` from broad catches. A narrow timeout caught
   next to its own `withTimeout`, or a catch of a non-cancellation subtype, is
   safe.
8. Replace application `runBlocking` with suspension or a lifecycle-bound
   boundary. `runTest` in tests; `runBlocking` only at a true blocking edge, kept
   small.
9. Check the changed call chain with the project's compile/test entry point (a
   validation action, not this skill). Finish when a reader can find the owner,
   start, cancellation and failure path without guessing.

## Scope and launch choices

| Situation | Action |
| --- | --- |
| Repository, manager, use case, data source needs async work | Expose `suspend`; caller chooses scope/error handling |
| UI callback reaches a UI state holder | Holder may launch on its lifecycle scope |
| Background reaction with observable coroutine-owning consumer | Suspend at the consumer's mutation/collection site |
| Periodic/deferred work | Enqueue scheduled work from a suspending orchestrator |
| Synchronous external API with no observable lifecycle | One explicit named launch site, never class `init` |
| Lifecycle infrastructure explicitly owns cancellation/errors/restart | May own a scope, but exposes visible start/stop |

The UI exception needs all three: the class owns UI state, its scope is cancelled
with that UI surface, and the caller is a real UI event/lifecycle hook. Lower
layers remain suspending.

```kotlin
class FavouritesViewModel(private val repository: FavouritesRepository) : ViewModel() {
    fun onToggle(item: Item) {
        viewModelScope.launch { repository.toggle(item) }
    }
}
```

An application singleton is not a loophole. Prefer, in order: invert observation
into a known consumer; schedule genuinely periodic work; launch a suspending
observer from one named orchestrator. If no reader can find who starts, observes,
stops or restarts the work, return to step 1.

## Cancellation

```kotlin
try {
    api.load()
} catch (error: CancellationException) {
    throw error
} catch (error: Exception) {
    logger.warn("load failed", error)
}
```

`runCatching` also catches cancellation; add the same guard or finish with
`getOrThrow()`. `currentCoroutineContext().ensureActive()` is appropriate when
ordinary failure is handled locally. Never turn cancellation into success.

## Blocking boundaries

Make suspend-capable application code suspend. At a non-suspending UI callback,
use the UI lifecycle scope; in tests use `runTest`.

Legitimate `runBlocking` places include CLI `main`, required synchronous
Java/framework bridges, and migration shims. An Android `ContentProvider` member
method is such a framework boundary; a companion/helper is not. Keep the body to
the direct suspending call.

Moving blocking work to a dispatcher does not make cancellation stop it. Wrap a
single interruptible JVM call in `runInterruptible(dispatcher)` or state the
blocking API's cancellation mechanism explicitly.

## Incremental refactor

1. Start at the leaf farthest from UI.
2. Convert one public function to `suspend`; follow compiler-reported callers.
3. At each caller, choose its lifecycle scope deliberately.
4. Remove the unused scope parameter and binding.

Do not apply this to an already-suspending API, a UI state holder handling its
own UI event, or a lifecycle owner with explicit cancellation/error/restart
policy. Do not repair every layer in one change.

## Risks and false positives

- A stored scope is not automatically wrong in lifecycle infrastructure; check
  whether cancellation and restart are genuinely owned and visible.
- A detached `Thread`/`Executor` may be required by an SDK. Judge observability
  and shutdown, not the mere presence of a thread.
- `runBlocking` on a background thread does not block Main unless Main waits on
  that thread. Prove the waiting relationship before calling it an ANR risk.
