# Compose state hoisting

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/compose-state-and-effects/references/state-hoisting.md
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed; screen-seam explanation kept. See ../../THIRD_PARTY_SOURCES.md.
-->

## Core principle

Hoist state only as far as its logic needs it; screen wiring and plain rendering
are separate owners.

## Procedure

1. List the state, operations, app dependencies, event streams and effects that
   need coordination.
2. Choose the lowest owner from the table.
3. Extract a plain state holder only when coordinated UI behavior is a real
   concept; keep a lone boolean or trivial text field local.
4. At a screen boundary, implement three seams:
   - small wiring owns app dependencies, durable data and effects;
   - composition or a plain UI state holder owns runtime UI objects;
   - a plain composable receives immutable UI state and event callbacks.
5. The content composable must not require runtime objects such as
   `LazyListState` or `FocusRequester`. It creates them or gives remembered
   defaults so sample state alone renders it.
6. Keep frame-clock operations such as scrolling or drawer animation in a
   composition-scoped coroutine, not `viewModelScope`.
7. Save only serializable values with `rememberSaveable`/a `Saver`, never runtime
   objects or callbacks.
8. Finish by stating the concrete boundary for an ownership review, or make no
   change when the existing owner already matches the evidence.

| Situation | Owner |
| --- | --- |
| One composable owns simple UI state | Local `remember` / `rememberSaveable` |
| Siblings or a parent share it | Lowest common composable owner |
| Related UI mechanics need named operations or coordinated state | Plain state holder remembered in composition |
| Repository calls, persistence, business rules, screen state production | Screen-level holder (`ViewModel`/component) |
| App wiring and layout are mixed | Small wiring composable plus plain UI composable |

```kotlin
@Composable
fun ProfileScreen(component: ProfileComponent, modifier: Modifier = Modifier) {
    val state by component.state.collectAsStateWithLifecycle()
    ProfileContent(
        state = state,
        onNameChange = component::onNameChange,
        onSaveClick = component::save,
        onBackClick = component::back,
        modifier = modifier,
    )
}

@Composable
fun ProfileContent(
    state: ProfileUiState,
    onNameChange: (String) -> Unit,
    onSaveClick: () -> Unit,
    onBackClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Render only; no ViewModel/component required.
}
```

A plain state holder can retain `LazyListState`, `FocusRequester`, `PagerState`,
drawer state and similar UI mechanics created in composition. Pass
business-relevant derived values across the screen boundary, not those runtime
objects. When a child must coordinate the holder, accept it deliberately;
otherwise pass plain values and callbacks.

## Exceptions

- Do not split a tiny one-off composable that already receives plain values and
  callbacks.
- Do not create a state-holder/UI overload for structural symmetry or a
  design-system primitive; use slots and modifiers there.
- If UI input drives repository-backed data, keep that input with the screen
  holder that produces the data.
- Do not invent a state holder because a preview would be convenient. A
  previewable content seam is useful only when the task needs that boundary.

## Review limits

Missing hoisting is a finding only when there is a concrete lifecycle,
testability, business or coordination need. In a focused contract review, do not
recommend moving a value that the code never shares.
