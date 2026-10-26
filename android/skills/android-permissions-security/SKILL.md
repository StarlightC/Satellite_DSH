---
name: android-permissions-security
description: Audit and remediate Android permission, exported-component, IPC caller-identity and runtime-permission risks using manifest evidence and Binder-verified identity, without claiming exploitability from static patterns alone.
whenToUse: Load when reviewing AndroidManifest.xml, services/receivers/providers, custom permissions, Binder/AIDL caller checks, deep links, or runtime permission flows; use only the reference that matches the surface under review.
---

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  security/android-permissions-security/SKILL.md and selected references.
Attribution: Google / Android. Licensed Apache-2.0; see ../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed and split into focused references. See ../THIRD_PARTY_SOURCES.md.
-->

# Android permissions and IPC security

## Authority and limits

Read-only security review. This skill does not access signing keys, credentials,
keystores or production data, does not send broadcasts or bind services, and
does not run device commands. A static pattern is a **risk finding**; exploit
impact requires the actual manifest, exported state, caller identity path and
(where relevant) a dynamic test. State that limit instead of claiming a breach.

An implementation node may apply the remediation only within its authorized
unit. A review node reports the finding and the check that would confirm it.
The calling node's role, sandbox and authorization remain authoritative; this
method widens neither.

## Audit matrix

| Surface | Risk pattern | Required direction |
| --- | --- | --- |
| Custom permission | `normal`, `dangerous`, deprecated `signatureOrSystem` protecting app-private IPC | Use `signature` (or `signature\|knownSigner` with trusted digests) and a package-prefixed name |
| Exported component | Missing `android:exported="false"` on a private component | Explicitly private, or permission-protected and intended |
| Provider URI grants | `pathPrefix="/"`, `pathPrefix=""`, broad read/write access | Scoped subpath plus split read/write permissions; retain `grantUriPermissions="true"` |
| Provider split permissions | Only generic permission, or no read/write split | Declare signature-level READ/WRITE permissions and assign both |
| Caller identity | `getStringExtra("calling_package")`, `getCallingPackage()` used as authentication | `Binder.getCallingUid()` inside an active IPC transaction plus signing-certificate check |
| Bound service | `checkCallingOrSelfPermission`/`enforceCallingOrSelfPermission` | `checkCallingPermission`/`enforceCallingPermission` on every mutating method |
| Runtime flow | Cached grant, missing rationale, looped request, no permanent-denial path | Check every time; three-state flow; settings path after permanent denial |
| Location | Foreground and background requested together | Foreground first, background only in a later explicit step |
| Media/storage | Broad storage permission for picking a photo | Photo Picker / zero-permission contract |
| Broadcast | Implicit broadcast, no receiver permission, no sender authentication | Explicit package, receiver permission, `setShareIdentityEnabled` on API 34+, or signature permission |
| PendingIntent | Sender trusted via `getCreatorPackage()`/`getCreatorUid()` | Never authenticate sender that way; use Binder UID or API 34 sender identity |

## Non-negotiable decisions

1. **Caller identity must be cryptographic.** Intent extras and package strings
   are attacker-controlled. `Binder.getCallingUid()` is valid only during an
   active IPC transaction; reject `callingUid == Process.myUid()` so a local or
   cleared-identity call fails closed. Verify the UID's certificate with
   `PackageManager.hasSigningCertificate()` (API 28+) or resolve packages and
   compare digests as a legacy fallback.
2. **Never use `checkCallingOrSelfPermission`/`enforceCallingOrSelfPermission`**
   to guard external callers. Outside an active IPC transaction, or after
   `clearCallingIdentity()`, they fall back to the host app and create a
   confused-deputy bypass.
3. **Export only what needs export, and scope it.** Private components are
   `exported="false"`. Exported providers get split signature permissions and
   path-scoped grants; no wildcard `pathPrefix`.
4. **Runtime permission state is not cacheable.** Check
   `ContextCompat.checkSelfPermission` at each protected operation, catch
   `SecurityException`, and handle grant, rationale, request and permanent denial
   without a request loop.
5. **Prefer zero-permission APIs.** Use the Photo Picker for user-selected media
   and request only the location accuracy the feature needs. Foreground and
   background location are separate user steps.
6. **Broadcast/PendingIntent identity has API-level limits.** On API 34+ use
   `BroadcastOptions.setShareIdentityEnabled(true)` and check
   `getSentFromPackage()`/`getSentFromUid()`. On API 33 and below, a receiver
   restricted by a signature permission is safer than creator identity; if
   `minSdk < 31`, use a bound service/provider with Binder UID verification.

## References

- [Manifest, provider and broadcast surfaces](references/manifest-ipc.md) —
  protection levels, `knownCerts`, split permissions, scoped URI grants,
  broadcast options and PendingIntent caveats.
- [Caller verification and bound services](references/caller-verification.md) —
  vulnerable versus secure UID/certificate checks, AIDL method enforcement and
  API-level fallbacks.
- [Runtime permission flows](references/runtime-permissions.md) — three-state
  flow, denial handling, location sequencing, Photo Picker, one-time/revoked
  permissions and test flags.

Do not widen a review beyond the declared surfaces. If the answer needs a
dynamic exploit test, signing material, or a production credential, report the
boundary rather than attempting it.
