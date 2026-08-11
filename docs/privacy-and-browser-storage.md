# Browser storage and privacy

Sub-Etha uses IndexedDB for durable browser-side state. Remembered mode stores the encrypted Matrix session, encrypted sync cache, encrypted drafts, encrypted push capabilities, non-extractable Web Crypto keys, and the Matrix Rust crypto database. This makes automatic sign-in, the existing encrypted-device identity, fast startup, drafts, and closed-app push possible.

Private mode keeps account state in memory. It creates no session, account, Rust crypto, draft, or push records. Reloading or closing the page requires authentication again, and closed-app push is unavailable because it requires durable device state.

## What encryption protects

Application-owned sensitive records use AES-256-GCM with a random IV and record-specific authenticated data. Room, user, and other logical identifiers are transformed with HMAC-SHA-256 before they are used as IndexedDB keys. The AES and HMAC keys are non-extractable Web Crypto keys stored for this origin.

This materially reduces what someone can learn by copying or scanning the application's IndexedDB files while Sub-Etha is not running. Raw application-owned records should not reveal access or refresh tokens, the Rust storage key, drafts, push capabilities, room or user IDs, or event content.

## What encryption does not protect

The keys are browser-profile/origin-bound, not guaranteed hardware-backed. Same-origin JavaScript can ask Web Crypto to use a non-extractable key even though it cannot export the key bytes. Device encryption therefore does not protect against:

- malicious same-origin JavaScript or a successful XSS while the app is running;
- a compromised browser or extension with sufficient access;
- operating-system malware or an attacker controlling the active browser profile; or
- plaintext already displayed in memory or on screen.

Sub-Etha reduces those risks with a per-response nonce CSP, strict security headers, dependency review, URL validation, and a mandatory DOMPurify boundary for formatted Matrix HTML. Those controls reduce attack likelihood; they do not make a compromised runtime safe.

## Sign-out and erasure

**Sign out and clear account data** removes the current account's encrypted session, account cache, Rust crypto databases, drafts, and push state. It preserves the theme, OAuth client registrations, device encryption keys, application shell cache, and installed PWA. A cleanup manifest records blocked or failed database deletions and retries them before the next login.

**Erase all Sub-Etha data** requires typing ERASE. It attempts to stop every tab, remove remote push state, unsubscribe the browser, delete all known Sub-Etha databases and caches, remove Sub-Etha Web Storage and pending auth data, delete device keys, and unregister the service worker. If the browser cannot enumerate databases, Sub-Etha warns that the browser's **Clear site data** control is required to guarantee removal of unidentified stale databases.

These operations perform logical deletion. Browsers cannot promise forensic erasure from SSD wear leveling, filesystem snapshots, synced browser data, backups, or crash artifacts.
