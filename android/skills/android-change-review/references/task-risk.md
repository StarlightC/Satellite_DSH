# Android task-risk supplement

Read when Android platform risks affect initial planning, reassessment, or the
review faces a task requires. These examples supplement the parent's general
rubric; they are not another classifier and do not select models or grant access.

## Platform triggers

Treat permissions/exported components, WebView, deep links, account/network/cache
or sync state, and privacy-sensitive analytics/logging/tracing as meaningful
security/data impact (normally at least 2 in the parent's rubric). Credentials,
tokens, personal data, authentication, billing and payments need the strongest
applicable data/security assessment. Assess actual effect, not keywords in a file.

Cross-module/state ownership, lifecycle, background execution, Flow/coroutines,
concurrency, migrations, integrity and performance uncertainty may require Senior
implementation or a specialist when the work cannot be safely decomposed. A
Critical task may still contain independent Light/Standard implementation units;
retain its platform review and validation obligations.

A mechanical resource-ID rename can be exempt from the scope-3 direct trigger only
with an exhaustive consumer list and no state/behaviour/ownership change. This does
not exempt other risks or the overall score. A local asset import is simple UI only
when the source is local, the target is clear, conversion is direct, there is no
consumer layout/state change and no unresolved design/screenshot dependency.
Design-source fidelity, shared primitives or complex UI state require the matching
design and visual evidence, not merely a stronger coding role.

Release-readiness is at least Standard; signing, sensitive credentials, platform
security, migrations, integrity, crash or production-stability uncertainty make it
Critical. Preparation does not authorize signing-key access, upload or publishing.

## Use available methods, not invented specialists

- For platform review, select the actual relevant `api`, `lifecycle`, `resources`,
  `security`, or `ui` faces in the declared scope. The existing
  `android.platform-review` extension runs at `review.after` when flat facts include
  `projectKind: "android"`, `android.review.required: true`, and a valid
  `android.review.scope` with source revisions and check faces.
- For source-sensitive design, use the available `android-design-handoff` method
  through the existing design-context extension before solution work. Fix the real
  source/revision; do not invent a target image or imply rendered comparison happened.
- Runtime/device uncertainty needs actual appropriately approved device/build
  evidence. A read-only review report cannot stand in for that execution.
- Architecture/security judgment beyond the registered methods is a capability gap.
  Return the exact specialist requirement to the parent/user; do not invent an
  `android.*` role, assume Android's presence supplies every specialist, or treat a
  Senior model choice as proof of specialist review.

The Android extensions return reports, not trusted machine acceptance facts. The
parent still checks applicability, evidence and remaining limits. If a report needs
more scope, a device, credentials or another permission, report that boundary; do
not obtain it by escalating to a different role.
