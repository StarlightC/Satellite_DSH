# Caller verification and bound services

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  security/android-permissions-security/SKILL.md (caller identity and bound-service sections);
  references/android/privacy-and-security/risks/sender-of-pending-intents.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed and corrected to a self-contained pattern. See ../../THIRD_PARTY_SOURCES.md.
-->

## 1. Never authenticate with intent extras

```kotlin
// Vulnerable: an attacker supplies a trusted package name.
val caller = intent.getStringExtra("calling_package")
if (caller != null && verifyPartnerPackage(this, caller)) grant()
```

The signature check may verify the *installed* partner, not the *caller*.
Remove all `calling_package`, `sender`, `package` string checks. Identity comes
from the Binder transaction.

## 2. Verify the calling UID and certificate

`Binder.getCallingUid()` returns the remote UID only during an active Binder
transaction (AIDL stub, provider method). In `Service.onStartCommand()` or
`onBind()` it can return the host UID; reject `Process.myUid()` so non-IPC or
cleared-identity calls fail closed.

```kotlin
object CallerVerifier {
    // Lowercase or uppercase hex, no colons, pinned at build time.
    private const val TRUSTED_SHA256_HEX =
        "a1b2c3d4e5f60708090a0b0c0d0e0f1011121314151617181920212223242526"

    fun isCallerAuthorized(context: Context): Boolean {
        val uid = Binder.getCallingUid()
        if (uid == Process.myUid()) return false

        val trusted = TRUSTED_SHA256_HEX.hexToBytes()
        val pm = context.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return pm.hasSigningCertificate(
                uid,
                trusted,
                PackageManager.CERT_INPUT_SHA256,
            )
        }

        val packages = pm.getPackagesForUid(uid) ?: return false
        return packages.any { packageName ->
            runCatching {
                @Suppress("DEPRECATION")
                val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES)
                val signatures = info.signatures ?: return@runCatching false
                signatures.any { signature ->
                    MessageDigest.getInstance("SHA-256")
                        .digest(signature.toByteArray())
                        .contentEquals(trusted)
                }
            }.getOrDefault(false)
        }
    }

    private fun String.hexToBytes(): ByteArray =
        chunked(2).map { it.toInt(16).toByte() }.toByteArray()
}
```

Notes:
- `hasSigningCertificate` (API 28+) checks the UID's signing history and accepts
  `CERT_INPUT_SHA256` bytes, not a hex string.
- On older APIs, `packageInfo.signatures` is nullable; guard it before
  iterating. Multiple packages can share a UID, so any matching trusted signer is
  the intended rule only if that is the actual product contract.
- The digest must be pinned as bytes/constant at build time. Do not fetch it at
  runtime from an untrusted source.
- Never convert a failed lookup or exception into "authorized".

## 3. Method-level checks in bound services

```kotlin
class SecureBoundService : Service() {
    private val binder = object : IMyService.Stub() {
        override fun getData(): String = "confidential" // manifest read permission

        override fun modifyData(newData: String) {
            enforceCallingPermission(
                "com.example.app.permission.WRITE_DATA",
                "Caller lacks WRITE_DATA",
            )
            updateInternalState(newData)
        }
    }

    override fun onBind(intent: Intent?): IBinder = binder
}
```

- Read-only methods may rely on the manifest binding/read permission.
- Every mutating AIDL method needs `enforceCallingPermission` (throws) or
  `checkCallingPermission` (returns) for the write permission.
- **Never** use `checkCallingOrSelfPermission` or
  `enforceCallingOrSelfPermission` here: the "or self" fallback checks the host
  app when the IPC identity is absent, which the host passes.
- Do not add a permission check only at `onBind()`; binding and method calls are
  separate authorization points.

## 4. Broadcast and PendingIntent identity

- API 34+: sender opts in with `BroadcastOptions.setShareIdentityEnabled(true)`;
  receiver checks `getSentFromPackage()`/`getSentFromUid()`.
- API ≤33: `PendingIntent.getCreatorPackage()`/`getCreatorUid()` identify the
  creator, not the sender. A malicious app that acquires the PendingIntent can
  send it. Restrict the receiver with a signature permission instead; if the
  project supports API <31, use a bound service/provider with UID verification.
- An explicit package prevents accidental exposure but is not authentication: a
  malicious app can still target an exported receiver unless a permission or
  sender check rejects it.

## 5. What static review can and cannot prove

A missing check is a risk, not a demonstrated exploit. To claim impact, identify
the exported entry point, the attacker-controlled input, the missing identity
check and the resulting privileged operation. If a dynamic test is needed, hand
that requirement to an approved validation path; do not fabricate a test result.
