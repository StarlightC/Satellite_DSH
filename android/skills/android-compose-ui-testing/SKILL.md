---
name: android-compose-ui-testing
description: Choose and review the smallest sufficient Jetpack Compose UI test seam for state-driven content, callbacks, semantics, interaction state, keyboard/focus behavior and screenshot evidence, without simulating fragile pointer input.
whenToUse: Load when writing or reviewing Compose UI tests, semantics assertions, interaction-state tests, screenshot/baseline evidence, or tests for a plain state-driven content composable.
---

<!--
Derived from chrisbanes/skills @ 6c30c500c36a1827c8fde75415dd7a31394bc02c:
  skills/compose-ui-testing-patterns/SKILL.md and references/interaction-state.md
Attribution: Chris Banes / chrisbanes/skills. Licensed Apache-2.0; see ../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: rewritten; unavailable focus-navigation link removed; local links used. See ../THIRD_PARTY_SOURCES.md.
-->

# Compose UI testing patterns

## Authority and limits

Read-only test-design guidance unless an implementation node authorizes adding
or changing tests. This skill does not run Gradle, an emulator, or screenshot
tooling; execution belongs to a validation node with the project's own entry
point. A test that was written but not run is not evidence. The calling node's
role, sandbox and authorization remain authoritative; this method widens neither.

## Core principle

Test the smallest UI contract that proves the behavior. Prefer plain
state-driven UI tests with callbacks. Add integration only when lifecycle,
navigation, dependency injection or platform behavior is the thing under test.

## Procedure

1. State the behavior and test concern to prove.
2. Inspect the existing test and choose the smallest sufficient seam from the
   table.
3. Keep focused edits within the requested concern. Do not move test-only
   helpers into production or broaden production APIs unless that boundary is
   itself under test.
4. Drive controlled state/input, synchronize through Compose, and assert an
   observable semantic, visual or callback result.
5. Finish with no edit when the existing test already uses the narrowest valid
   seam and proves the requested behavior.

## Test target choice

| Prove | Test shape |
| --- | --- |
| Text, button, loading/error branch, conditional content | Plain UI Compose test |
| Callback wiring from click/input | Plain UI Compose test |
| Focus navigation or keyboard behavior | Compose test with key input |
| Visual layout, clipping, elevation, typography, image composition | Screenshot test |
| State holder updates UI correctly | State holder/unit test plus one wiring smoke test |
| Hover, pressed, focused, dragged interaction state | Plain UI test with `MutableInteractionSource` |
| Navigation, lifecycle, DI integration | Integration test |

## Prefer plain UI tests

If the screen has a state-holder/UI split, test the content composable directly:

```kotlin
composeTestRule.setContent {
    ProfileContent(
        state = ProfileUiState(name = "Ada", canSave = true),
        onNameChange = {},
        onSaveClick = { saved = true },
        onBackClick = {},
    )
}

composeTestRule.onNodeWithText("Ada").assertIsDisplayed()
composeTestRule.onNodeWithText("Save").performClick()

composeTestRule.runOnIdle { assertThat(saved).isTrue() }
```

This avoids constructing ViewModels, repositories, navigation and dependency
graphs for layout behavior. The content composable comes from the state/effect
method; see [Compose state and effects](../android-compose-state-effects/SKILL.md).

## Semantics first

- Text exists: `onNodeWithText`.
- Enabled/disabled: `assertIsEnabled` / `assertIsNotEnabled`.
- Selected/focused/toggled: the corresponding semantics assertion.
- Absent: `assertDoesNotExist`.
- Use test tags for nodes with no stable visible text or where several nodes
  share text. Do not make tags the default; user-visible semantics are usually a
  stronger contract.

## Callback testing

Use simple counters or captured values. For a plain captured callback, a direct
assertion after the action is usually enough. Use `runOnIdle` when the assertion
must wait for Compose to apply snapshot state, recomposition or queued UI work.

## Determinism

- Render controlled state with `setContent` rather than the production graph for
  layout/branch/callback tests.
- Do not use `Thread.sleep` to wait for Compose. Use semantic assertions and
  Compose synchronization (`waitForIdle`, `runOnIdle`, or a bounded `waitUntil`
  for a real async condition).
- If `mainClock.autoAdvance = false`, advance the clock deliberately
  (`mainClock.advanceTimeBy`) before asserting the intended time; do not
  interleave clock checks within one frame. Otherwise leave auto-advance on.
- Reserve full-app integration for behavior that actually depends on navigation,
  lifecycle, DI or platform wiring.

## Interaction state

When hover, press, focus or drag is the concern, inject a
`MutableInteractionSource` and emit the interaction; do not simulate pointer
events. Read [the interaction-state procedure](references/interaction-state.md)
before writing the test.

## Keyboard and focus

Drive navigation with the same input model users use (keys/D-pad), not clicks
alone. Assert focused semantics, not colors or scale. Reserve screenshots for
visual focus treatment. If the composable exposes no input surface that can change
the state, name the missing host/parent seam before proposing a key-driven test.
Focus graph and restoration semantics are not covered by a dedicated method here;
do not link or invent one.

## Screenshot tests

Use screenshots for visual contracts semantics cannot prove: spacing/alignment,
themed colors/typography/elevation, image composition, focus highlight, loading
skeletons or dense visual states.

Keep state deterministic: fixed data, frozen clocks/animation where possible,
fake image loading, and no dynamic text such as current time unless controlled.

When a default changes intentionally, update the named preset/baseline rather
than substituting a raw value to preserve the old image. Verify recording
separately from comparison: read the exact expected artifact path from the test,
confirm the file exists, and name that literal path. A passing comparison does
not prove recording wrote the artifact. If the artifact or baseline diff is
unavailable, report the gap; do not claim recording succeeded. Tool-specific
commands belong to the repository runbook, not this method.

## Fake images and platform services

When image content is irrelevant, fake the loader and assert the requested model.
When appearance matters, provide a deterministic local painter/bitmap instead of
network data. The exact hook depends on the image library; do not invent a
Compose API such as a fake loader builder.

## Reporting

State the seam chosen, what it proves, what it does not (for example, a plain UI
test does not prove navigation or DI), whether it ran, and the actual pass/fail
evidence. Do not present a test file as a passing check.
