---
name: android-compose-state-effects
description: Choose Compose state ownership, hoisting, saveability and effect lifecycle for local UI state, screen state holders, Flow collection, callbacks, cleanup, navigation, snackbar and analytics.
whenToUse: Load when writing or reviewing Compose state ownership, remember/rememberSaveable, state hoisting, screen/content seams, LaunchedEffect/DisposableEffect/SideEffect, or one-shot UI events.
---

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/compose-state-and-effects/SKILL.md and references.
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: rewritten; unavailable upstream links removed; local links used. See ../THIRD_PARTY_SOURCES.md.
-->

# Compose state and effects

## Authority and limits

Read-only ownership/effect review unless an implementation node authorizes a
change. This skill does not add product requirements, does not run previews or
tests, and does not promote a missing owner to a finding without code or task
evidence. Focus navigation semantics are out of scope here; do not invent a
provider or focus API for them. The calling node's role, sandbox and
authorization remain authoritative; this method widens neither.

## Core principle

Give every piece of UI state one lowest responsible owner, then run imperative
work through the effect whose lifecycle follows that owner. Composition renders;
state and effects make rendering change safely.

A screen-ownership review is incomplete until it names the plain, previewable
content composable that receives immutable state and event callbacks separately
from app wiring and composition-owned runtime objects.

## Procedure

1. Establish the requested behavior and visible requirements. Treat an ownership
   change as a finding only when code or task evidence shows a lifecycle,
   testability, business or coordination need. In a focused contract review, a
   provider/owner/writer the code never needs is at most a noted risk.
2. Inventory mutable UI state, app state, event streams, app dependencies and
   imperative work in the affected screen/component.
3. Place each value at its lowest owner: local UI state, hoisted state, a plain
   UI state holder, or a screen state holder.
4. At a screen boundary, keep durable data and intents in the wiring owner,
   Compose runtime objects in composition or a plain UI state holder, and render
   in a plain composable that takes immutable state and callbacks. See
   `references/state-hoisting.md`.
5. Choose an effect whose lifecycle matches the work; key it by the semantic
   input that should restart or dispose it. See
   `references/side-effects.md`.
6. Finish when every state value has one owner, every effect has a justified
   lifecycle/key, and the UI can be rendered with sample state without app
   dependencies. For review-only work, report no change when no evidence-backed
   issue remains.

## Ownership at a glance

| Situation | Owner |
| --- | --- |
| One composable owns simple UI state | Local `remember` / `rememberSaveable` |
| Siblings or a parent share it | Lowest common composable owner |
| Related UI mechanics need named operations/coordinated state | Plain state holder remembered in composition |
| Repository calls, persistence, business rules, screen state | Screen-level holder (`ViewModel`/component) |
| App wiring mixed with layout | Small wiring composable plus plain UI composable |

A plain state holder may retain `LazyListState`, `FocusRequester`, `PagerState`
or drawer state created in composition. Do not expose those runtime objects to a
screen-level holder; pass business-relevant values and callbacks across the
boundary. Keep frame-clock operations (scroll/drawer animation) in a
composition-scoped coroutine, not `viewModelScope`.

## Seams to verify

1. **Wiring owner** — creates the state holder, owns app dependencies, durable
   data and top-level effects.
2. **Composition/runtime owner** — remembers UI mechanics and maps events to the
   state holder.
3. **Plain content** — accepts immutable state plus event callbacks; does not
   require a `ViewModel`, `LazyListState` or `FocusRequester`. It may create
   remembered defaults so sample state alone renders it.

A `@Preview` wrapper is optional. Before adding one, confirm the module declares
Preview tooling; do not assume Compose runtime/UI supplies it, and do not change
build files outside the task. If the tooling is unavailable in scope, omit the
wrapper and report the gap.

## Effects at a glance

| Need | API |
| --- | --- |
| Publish after successful recomposition | `SideEffect` |
| Register/unregister a listener or resource | `DisposableEffect` with real cleanup |
| Suspending/deferred/keyed work | `LaunchedEffect` |
| Suspend work caused by a user event | `rememberCoroutineScope()` |
| Convert snapshot reads to a Flow | `snapshotFlow { }` with a terminal collect |

Key by the identity that should restart the work. Use `rememberUpdatedState` for
a callback that must stay current without restarting, and read it lazily. Collect
render state near the state holder; collect one-shot event flows with an explicit
delivery contract (see `android-kotlin-concurrency`).

## References

- [Local state](references/local-state.md) — `remember`/`rememberSaveable`,
  snapshot collections, derived state and saveability.
- [State hoisting](references/state-hoisting.md) — owners, three seams and
  previewable content.
- [Side effects](references/side-effects.md) — effect selection, keys, cleanup,
  Flow collection and stale captures.

## Related

- [Compose performance](../android-compose-performance/SKILL.md) — phase
  deferral, stability and measurement caveats.
- [Compose UI testing](../android-compose-ui-testing/SKILL.md) — plain UI tests
  for the state/callback contract.
- [Kotlin concurrency](../android-kotlin-concurrency/SKILL.md) — Flow event and
  cancellation semantics.
