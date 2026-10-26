# Flow: state and event modeling

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/kotlin-concurrency-and-flow/references/flow-state-events.md
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed; dead upstream links replaced with local ones. See ../../THIRD_PARTY_SOURCES.md.
-->

## Core principle

Choose a primitive from its replay, fan-out, buffer and synchronous-read contract.
Do not manufacture fake domain data to satisfy an initialization requirement.

## Choose the contract

| Need | Primitive |
| --- | --- |
| Current renderable state with synchronous `.value` | `StateFlow`; often eager when `.value` must be fresh |
| Hot broadcast without synchronous `.value` | Deliberately configured `SharedFlow` |
| At most one receiver per element, loss acceptable | Buffered `Channel`, exposed as `receiveAsFlow()` |
| Independent stream per collector | Cold `Flow` |

Before choosing `SharedFlow`, ask: may an event be lost when no collector is
active, and must every observer receive it? A `Channel` hands each element to at
most one receiver: it is a handoff, not a broadcast, and it guarantees neither
delivery nor exactly-once processing. When delivery must be reliable, model it as
recoverable state (a persisted pending item, an acknowledgement, idempotent
replay); a `Channel` alone does not provide that. Use durable state or deliberate
broadcast semantics when every observer must see the event. Capacity, overflow
policy, close and cancellation decide when an element can be lost; see
[Failure and lifecycle](#failure-and-lifecycle).

```kotlin
private val navigation = Channel<Navigation>(Channel.BUFFERED)
val navigationEvents: Flow<Navigation> = navigation.receiveAsFlow()
```

A one-consumer navigation handoff that must survive a short collector gap needs a
bounded `Channel(Channel.BUFFERED)`, not an unbounded channel and not a
replay-zero `SharedFlow` after event loss has been identified as the defect. The
buffer only makes loss less likely within its capacity and lifetime; it is not a
delivery guarantee. A replay-zero `SharedFlow` is valid only when losing events
while unsubscribed is acceptable.

## State initialization and updates

`StateFlow` requires an initial value. If absence, loading or error is real,
model it explicitly (`User?`, sealed UI state, `Result`); do not leak a fake
`NoUser` or placeholder ID as domain data. If the API can be phased so observers
first see a real value, do that instead.

Use `update` for concurrent transforms and keep the lambda pure and fast. It may
retry; capture I/O, logging inputs, random IDs and time before it unless they are
derived from current state.

```kotlin
val details = Details.from(response)
_state.update { current -> current.copy(details = details) }
```

## Sharing and derived state

Expose `stateIn` as one shared property, not a function that starts a new sharing
coroutine per call.

```kotlin
val name: StateFlow<String> = userState
    .map { it.name }
    .stateIn(viewModelScope, SharingStarted.Eagerly, userState.value.name)
```

- `SharingStarted.Eagerly` when `.value` must be initialized/fresh without an
  active collector.
- `WhileSubscribed` when a stale/cached value without a collector is acceptable
  and collection is primarily asynchronous.
- `map` turns a `StateFlow` into a plain `Flow`; if callers need synchronous
  `.value`, finish the derived stream with `stateIn`.
- Utilities that transform on each `.value` read are only for fast, idempotent
  work.

Finish by stating consumer count, absent-collector behavior, delivery guarantee,
replay, buffer and `.value` requirements. If any is unknown, the primitive is not
decided yet.

## Failure and lifecycle

- A `StateFlow` cannot signal failure by never emitting; put failure in the
  state type or expose a separate error channel with explicit semantics.
- A `SharedFlow` with no replay drops events for late subscribers; this is a
  contract, not a bug, only if the product accepts it.
- A `Channel` capacity is a backpressure decision. A bounded buffer makes the
  producer suspend or `trySend` fail once full; `UNLIMITED` can hide a slow
  consumer and grow memory. Prefer a bounded buffer with a defined overflow
  policy, and note that the element such a policy drops is gone.
- A `Channel` closed normally drains what is still buffered and then completes its
  collectors; closing it with a cause drains the same way, then fails them with
  that cause, while `cancel()` discards the buffer at once and resumes suspended
  senders and receivers with cancellation. There is no replay, so elements already
  received or discarded are not recoverable from the channel.
- Collection should stop with the owner's lifecycle (for example Compose
  lifecycle-aware collection). A raw `collect` in a long-lived scope keeps the
  producer alive.

## Related

- [Structured concurrency](structured-concurrency.md) — scope and cancellation
  ownership.
- [Compose state and effects](../../android-compose-state-effects/SKILL.md) — UI
  collection and effect lifetime.
