# Interaction-state tests

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/compose-ui-testing-patterns/references/interaction-state.md
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed; scope caveat added. See ../../THIRD_PARTY_SOURCES.md.
-->

When a composable's appearance or behavior depends on hover, focus, press or
drag, inject a `MutableInteractionSource` and emit the desired interaction
directly. Do not simulate pointer or mouse events: that depends on layout and
environment and is flaky.

```kotlin
@Test
fun hoverShowsHoveredLabel() {
    val interactionSource = MutableInteractionSource()

    composeTestRule.setContent {
        val hovered by interactionSource.collectIsHoveredAsState()
        OutlinedButton(
            onClick = {},
            interactionSource = interactionSource,
        ) {
            Text(if (hovered) "Hovered" else "Idle")
        }
    }

    composeTestRule.onNodeWithText("Idle").assertIsDisplayed()

    interactionSource.tryEmit(HoverInteraction.Enter())
    composeTestRule.waitForIdle()

    composeTestRule.onNodeWithText("Hovered").assertIsDisplayed()
}
```

The interaction alone is not an assertion: make the state observable. Here the
button content reads `collectIsHoveredAsState`, so the test asserts a state change
it can see rather than re-reading the interaction object or only re-asserting the
button is displayed.

The same pattern applies to `PressInteraction.Press` / `Release` / `Cancel`,
`FocusInteraction.Focus` / `Unfocus`, and `DragInteraction.Start` / `Stop` /
`Cancel`: emit the entry interaction, wait for idle, then assert the result.

Rules:

- Always inject the `MutableInteractionSource`; do not rely on the component's
  internal default.
- `emit` is suspend; `tryEmit` is its non-suspending form. Prefer `tryEmit` in a
  synchronous test so no coroutine scope is needed. If you must use `emit`, run
  it on a test-controlled coroutine scope and cancel the scope when the test
  ends; do not use a production `LaunchedEffect` as a test tool.
- Assert the observable visual, semantic or enabled-state result, not the
  interaction object. The source drives the test; it is not the assertion.
- For screenshots, emit the state before capture so hover/press/focus visuals are
  deterministic.
- A passing interaction emission does not prove accessibility semantics or
  keyboard behavior; use a semantics/key test for those contracts.
