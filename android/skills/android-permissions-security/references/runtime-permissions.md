# Runtime permission flows

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  security/android-permissions-security/SKILL.md (runtime sections);
  references/android/training/permissions/requesting.md;
  references/android/guide/topics/permissions/overview.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed to an implementation and review checklist. See ../../THIRD_PARTY_SOURCES.md.
-->

## 1. Three-state request flow

Ask in context, when the user invokes the protected feature. Do not request at app
start or cache a previous grant.

```kotlin
private val cameraLauncher = registerForActivityResult(
    ActivityResultContracts.RequestPermission(),
) { granted ->
    if (granted) {
        startCamera()
    } else if (!shouldShowRequestPermissionRationale(Manifest.permission.CAMERA)) {
        // Permanently denied or policy-blocked: offer app settings, do not loop.
        startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                .setData(Uri.fromParts("package", packageName, null)),
        )
    } else {
        showInlineRationale()
    }
}

fun requestCamera() {
    val permission = Manifest.permission.CAMERA
    when {
        ContextCompat.checkSelfPermission(this, permission) ==
            PackageManager.PERMISSION_GRANTED -> startCamera()
        shouldShowRequestPermissionRationale(permission) -> {
            showRationaleThen { cameraLauncher.launch(permission) }
        }
        else -> cameraLauncher.launch(permission)
    }
}
```

- `checkSelfPermission` runs every time before the protected call; a grant can be
  revoked while the process is alive.
- `shouldShowRequestPermissionRationale` is not a persisted "denied forever"
  flag. On the first request it may be false; use the callback plus the absence
  of a rationale after denial to offer settings.
- Do not launch a request again from the permanent-denial branch; that is the
  loop the flow is meant to prevent.
- Gracefully degrade: show which feature is unavailable and keep the rest of the
  app usable. Do not block the whole UI.

## 2. Wrap protected calls

```kotlin
try {
    val location = locationManager.getLastKnownLocation(provider)
    process(location)
} catch (error: SecurityException) {
    // Permission revoked between check and call, or restricted by policy.
    requestForegroundLocation()
}
```

Catch `SecurityException` around framework calls that can lose permission
between the check and the operation. Do not treat it as a programming error.

## 3. Location is sequential

Request foreground accuracy first:

```kotlin
foregroundLauncher.launch(
    arrayOf(
        Manifest.permission.ACCESS_COARSE_LOCATION,
        Manifest.permission.ACCESS_FINE_LOCATION,
    ),
)
```

Only after foreground is granted, and only if the product truly needs background
access, request `ACCESS_BACKGROUND_LOCATION` in a separate explicit step.
Requesting both together is rejected on Android 11+.

Android 10+ background location needs the manifest declaration; a foreground
service using location also needs `foregroundServiceType="location"` on API 29+.
Play policy may further restrict background location; do not assume a technical
grant is policy approval.

## 4. Prefer zero-permission media selection

Use the Photo Picker instead of `READ_MEDIA_IMAGES` or `READ_EXTERNAL_STORAGE`
when the user is choosing an image:

```kotlin
val picker = registerForActivityResult(
    ActivityResultContracts.PickVisualMedia(),
) { uri -> uri?.let(::handleImageUri) }

picker.launch(
    PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
)
```

The picker returns a scoped URI and avoids broad library access. Use broad media
permissions only when the feature genuinely enumerates the library.

## 5. One-time and revoked permissions

- Android 11+ may grant camera/mic/location "only this time". The app can lose
  access when backgrounded or when the user revokes it; the process may be
  killed. Re-check on return and re-request when the feature is next used.
- Android 11+ auto-resets unused app permissions after months of inactivity.
  Never assume a previous grant persists across long gaps.
- Android 13+ `revokeSelfPermissionOnKill()` can proactively drop a permission
  the app no longer needs. This is a product-consent action, not a test shortcut.
- `adb shell dumpsys package <pkg>` shows `USER_SET` (denied once) and
  `USER_FIXED` (permanently denied). Testers can reset with
  `adb shell pm clear-permission-flags <pkg> <permission> user-set user-fixed`
  in an approved device step; this skill does not run it.

## 6. Review checklist

- Permission is declared in the manifest and requested only at the feature.
- Every protected call is preceded by a current check or guarded by
  `SecurityException`.
- Rationale is shown when the system asks for it, with a cancel path.
- Permanent denial leads to settings or a degraded feature, never a loop.
- Foreground/background location are not requested together.
- Photo selection uses the picker where possible.
- No in-memory `granted` cache survives revocation.
- If the test cannot cover a policy-restricted permission, record that as an
  unverified platform limit rather than assuming success.
