# Privacy hardening release

This release changes Sub-Etha's browser-storage contract.

- Existing remembered sessions migrate once to encrypted version-2 storage. The legacy unencrypted sync cache is discarded, so the first launch performs a fresh Matrix sync. The existing Rust crypto database, device identity, database prefix, and storage key are preserved.
- Remembered sessions now encrypt the full session, Matrix sync cache, drafts, and push capabilities with non-extractable Web Crypto keys. New account database names are opaque and Matrix identifiers are not used as record keys.
- Sign-in now offers an optional private mode. Private sessions persist no account, crypto, sync, draft, or push state; a reload requires authentication.
- Closed-app push is unavailable in private mode because subscription renewal requires durable device state.
- Sign-out reports complete or partial cleanup and retries blocked database deletion. A separate **Erase all Sub-Etha data** action removes all managed origin data after ERASE confirmation.
- Production documents now use a fresh nonce-based Content Security Policy plus restrictive browser security headers.

Operators should deploy previews with CSP_REPORT_ONLY=1, complete login/crypto/push smoke tests, and then remove the flag before production. Do not roll back migrated users to a build that understands only the plaintext matrix-session record; roll forward or use a storage-compatible build.

Device-key encryption improves resistance to offline database copies. It is not hardware-backed by contract and does not protect against malicious same-origin JavaScript, a compromised browser or extension, malware, or an attacker controlling the active profile. Browser deletion is logical deletion, not guaranteed forensic erasure from physical media or backups. See [Browser storage and privacy](../privacy-and-browser-storage.md).
