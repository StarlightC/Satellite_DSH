# Manifest, provider and broadcast surfaces

<!--
Derived from android/skills @ 4ebabf2b0fd6c04b7150023c8b612f80592a6226:
  security/android-permissions-security/SKILL.md;
  references/android/guide/topics/manifest/permission-element.md;
  references/android/privacy-and-security/risks/sender-of-pending-intents.md
Attribution: Google / Android. Licensed Apache-2.0; see ../../LICENSE-APACHE-2.0.txt.
Modified by Satellite DSH: condensed, snippets reduced. See ../../THIRD_PARTY_SOURCES.md.
-->

## 1. Protection levels

| Level | Grant rule | Use |
| --- | --- | --- |
| `normal` | Automatic at install | Low-risk, not for private IPC |
| `dangerous` | Runtime user grant | User-visible private data/actions |
| `signature` | Same signing certificate as declarer | Same-developer IPC |
| `signature\|knownSigner` (API 31+) | Certificate digest listed in `android:knownCerts` | Named partner apps |
| `signatureOrSystem` | Deprecated API 23 | Do not use for new code; migrate to `signature` |

Custom permission names should be package-prefixed:
`com.example.app.permission.ACCESS_SECURE_API`.

```xml
<permission
    android:name="com.example.app.permission.ACCESS_SECURE_API"
    android:protectionLevel="signature" />
```

For a partner app, store lowercase SHA-256 certificate digests without colons:

```xml
<permission
    android:name="com.example.app.permission.PARTNER_API"
    android:protectionLevel="signature|knownSigner"
    android:knownCerts="@array/trusted_partner_certs" />
```

The declaration must be under `<manifest>`, not inside a component. A custom
permission does nothing unless the component or method actually enforces it.

## 2. Exported components

- Private: `android:exported="false"`; this is stronger than inventing a
  permission.
- Exported service: `android:permission` plus method-level enforcement for
  mutating Binder calls.
- Exported receiver: required sender/receiver permission; prefer explicit
  package targeting.
- Exported provider: split read/write permissions and scoped URI grants.

```xml
<permission
    android:name="com.example.app.permission.READ_DATA"
    android:protectionLevel="signature" />
<permission
    android:name="com.example.app.permission.WRITE_DATA"
    android:protectionLevel="signature" />

<provider
    android:name=".data.SecureDataProvider"
    android:authorities="com.example.app.partnerprovider"
    android:exported="true"
    android:readPermission="com.example.app.permission.READ_DATA"
    android:writePermission="com.example.app.permission.WRITE_DATA"
    android:grantUriPermissions="true">
    <grant-uri-permission android:pathPrefix="/shared/" />
</provider>
```

Remove wildcard `android:pathPrefix="/"` or `pathPrefix=""`; a grant intended for
one shared directory otherwise exposes the whole provider.

## 3. Runtime URI permission

Scope temporary access to one URI rather than a broad manifest grant:

```kotlin
context.grantUriPermission(
    targetPackage,
    uri,
    Intent.FLAG_GRANT_READ_URI_PERMISSION,
)

// Receiver, for durable access across reboots:
contentResolver.takePersistableUriPermission(
    uri,
    Intent.FLAG_GRANT_READ_URI_PERMISSION,
)

// Audit and revoke when the transfer ends.
val held = contentResolver.persistedUriPermissions
context.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
```

`FLAG_GRANT_WRITE_URI_PERMISSION` should be granted only when the receiver must
write. A persisted grant outlives the screen; audit it rather than granting it
"just in case".

## 4. Broadcasts

```kotlin
val intent = Intent(ACTION_SECRET_UPDATE).apply {
    setPackage("com.example.partner")  // explicit target
}

if (Build.VERSION.SDK_INT >= 34) {
    // sendBroadcast(Intent, String, Bundle) exists only from API 34. Sharing
    // identity lets the receiver read getSentFromPackage()/getSentFromUid().
    val options = BroadcastOptions.makeBasic()
        .setShareIdentityEnabled(true)
        .toBundle()
    sendBroadcast(intent, RECEIVE_SECRET_UPDATE, options)
} else {
    sendBroadcast(intent, RECEIVE_SECRET_UPDATE)
}
```

Receiver on API 34+; the identity is visible only because the sender opted in:

```kotlin
if (Build.VERSION.SDK_INT >= 34 && getSentFromPackage() != "com.example.trusted") return
```

On API 33 and below, do **not** authenticate the sender with
`PendingIntent.getCreatorPackage()`/`getCreatorUid()`: the creator and sender can
differ, and a malicious app can acquire and send another app's PendingIntent.
Restrict the receiver with a `signature`/`signature|knownSigner` permission. If
`minSdk < 31`, use a bound service or ContentProvider and verify
`Binder.getCallingUid()`.

## 5. Misjudgement risks

- A manifest permission on an exported component is not proof that every
  sensitive method checks the right identity; method-level writes need their own
  enforcement.
- `android:exported` defaults changed across API levels and intent filters;
  read the actual merged manifest, not only the source file.
- Signature verification proves which certificate signed the installed package;
  it does not prove the intent sender. Bind the check to the live caller UID.
- `knownSigner` requires compile/target SDK 31+ and a digest that matches the
  partner certificate exactly; a typo fails closed, but test it.
