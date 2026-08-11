# ADR-0015: Encrypt browser persistence and enforce a nonce CSP

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: browser persistence, account lifecycle, content security policy, and storage migration
- Supersedes: [ADR-0004](./0004-client-storage-and-tab-ownership.md)

## Context

A remembered Matrix client needs durable access and refresh tokens, device identity, Rust crypto-store credentials, sync state, drafts, and optional push-management capabilities. Keeping these values only in the browser preserves the browser-to-homeserver privacy boundary, but plaintext browser records and identity-bearing database names make an offline browser-profile copy unnecessarily revealing. Sign-out also needs an observable result: requesting deletion is not the same as knowing whether an open connection blocked it.

Browser-side encryption and a strict Content Security Policy address different threats. Encryption reduces exposure from copied application databases. CSP and formatted-HTML sanitization reduce the chance that injected web content can run as same-origin code. Neither mechanism makes a compromised browser trustworthy.

## Decision

### Storage modes

Remembered mode remains the default. It persists an encrypted session, encrypted Matrix sync cache, encrypted drafts, optional encrypted push configuration, and the SDK Rust crypto store so automatic sign-in and the existing Matrix device identity continue to work.

Private mode is optional. It stores no Matrix session, account database, Rust crypto database, draft, or push configuration. It uses the SDK memory store, disables IndexedDB for Rust crypto, keeps drafts in memory, disables closed-app push, and requires authentication after reload or close. Password, access-token, OAuth, and SSO flows carry this choice; redirect flows keep it only in session storage.

Only one tab owns the live Matrix client. Destructive cleanup coordinates all tabs with BroadcastChannel and retains the storage-event fallback.

### Cryptographic storage contract

The version-2 session database persists two versioned Web Crypto keys:

- a non-extractable AES-256-GCM key with encrypt/decrypt usage; and
- a non-extractable HMAC-SHA-256 key used to derive deterministic opaque keys for room, user, and other logical identifiers.

Application-owned sensitive values are stored only in EncryptedEnvelopeV1, which contains a schema version, algorithm identifier, random 96-bit IV, and ciphertext. AES-GCM additional authenticated data binds the application, schema, database, store, logical record type, and derived record key. Moving ciphertext to another record or changing the IV, AAD, type, or version fails authentication.

New remembered accounts receive a random 128-bit local store ID. Account database names and Rust crypto prefixes use opaque IDs; HMAC-derived values replace Matrix room and user identifiers in record keys. Existing Rust crypto databases retain their legacy prefix and exact 32-byte storage key during migration because unsupported renaming would create a new device identity.

Decrypted data is untrusted input. Session reads validate structure, authentication kind, URL policy, OAuth metadata, token types, finite expiry, opaque local IDs, and Rust storage-key length before starting a client.

### Encrypted Matrix and draft storage

EncryptedMatrixStore builds on the SDK's public MemoryStore and SyncAccumulator. Memory remains the live source of truth. Encrypted persistence covers sync snapshots, client options, presence, out-of-band memberships, user profiles, to-device batches, and drafts. Pending outbound events remain memory-only.

The store keeps at most 50 timeline events per room and persists a sync snapshot at five-minute intervals. Plaintext is bounded before encryption: 64 KiB for a session, 256 KiB for a draft, 64 MiB for a sync snapshot, and 8 MiB for an auxiliary record. Corrupt, over-quota, over-limit, or failed cache writes emit a degraded state and continue in memory. Session corruption fails closed.

Push delivery, management, and VAPID capabilities share one encrypted record. The page directly awaits writes and deletes. The service worker retrieves the same non-extractable AES key and decrypts push configuration only for subscription renewal; notification payloads and content are never persisted.

### Migration

On first version-2 startup, Sub-Etha validates the legacy session, creates or loads device keys, assigns an opaque local store ID, writes the encrypted session, and deletes the plaintext session in the same final transaction. An interruption therefore leaves a valid legacy record or a valid encrypted record.

Legacy drafts and push capabilities are encrypted before their plaintext copies are removed. The unencrypted sync database is deleted and rebuilt with a fresh encrypted sync. Existing Rust crypto database names and keys are preserved. If any sensitive migration cannot complete, startup stops at recovery/reset UI and does not continue with silently retained plaintext.

A migrated origin must not be downgraded to a build that understands only the plaintext matrix-session record. Recovery rolls forward or uses a compatibility build.

### Account cleanup and full reset

Normal sign-out is account-scoped. Before remote teardown it writes an encrypted cleanup manifest naming the exact account and Rust databases. Remote pusher, gateway, browser subscription, and Matrix-token removal are best effort and never block local cleanup. The client stops, store connections close, the Web Lock is released, and local credentials, account data, Rust databases, drafts, and push configuration are removed.

IndexedDB deletion attempts are bounded to five seconds and report cleared, blocked, or failed by scope. The cleanup manifest remains until all local deletion succeeds and is retried before the next login. Theme, OAuth client registrations, device encryption keys, the shell cache, and installed-PWA state survive normal sign-out.

Erase all Sub-Etha data requires typing ERASE. It stops all tabs, captures any decryptable push management capability for best-effort remote cleanup, unsubscribes push, deletes known and discoverable Sub-Etha databases, removes Sub-Etha Web Storage and Cache Storage entries, deletes device keys and pending auth state, and unregisters the service worker. It reports complete or partial results and does not automatically recreate storage. When indexedDB.databases() is unavailable, the app clears every known current database and tells the user that the browser's Clear site data control is required to guarantee removal of unidentified stale stores.

### Browser security policy

Every document request receives a fresh 128-bit Base64URL nonce. Production sends an enforced CSP on the forwarded request and response so Vinext applies the nonce to framework, RSC, and inline scripts. Production script-src contains neither unsafe-inline nor unsafe-eval; React debugging adds unsafe-eval only in development. Development also permits loopback HTTP/WebSocket homeservers and omits insecure-request upgrading.

The policy denies objects, frames, embedding, and base URL changes; restricts forms, fonts, workers, images, media, and connections to their declared application needs; and uses strict-dynamic plus wasm-unsafe-eval. In production, inline style attributes remain allowed for current React sizing and progress behavior, while style elements require the response nonce. Components that generate style elements, including the emoji picker, receive that nonce explicitly.

Vinext's development renderer injects Vite CSS before the request nonce reaches the application layout. Development therefore permits inline style elements as a tooling-only compatibility exception. Preview and production builds never receive that exception and remain covered by the production-server CSP suite.

CSP_REPORT_ONLY=1 changes only the CSP header for preview or emergency diagnosis. Sub-Etha does not operate a CSP reporting endpoint and does not collect browsing telemetry. Supporting headers disable referrer disclosure, MIME sniffing, framing, cross-origin opener sharing, and unnecessary browser permissions while leaving notifications available.

DOMPurify remains mandatory before formatted Matrix HTML reaches dangerouslySetInnerHTML.

## Security properties and limits

The non-extractable keys are bound to the browser profile and origin but are not guaranteed hardware-backed. They improve resistance to an offline copy or casual inspection of application-owned IndexedDB records. They do not protect plaintext after the running application decrypts it.

In particular, this design cannot defeat malicious same-origin JavaScript, successful XSS that bypasses CSP and sanitization, a compromised browser or extension with sufficient access, operating-system malware, or an attacker controlling the active user profile. Such code can ask Web Crypto to decrypt data without exporting the key. CSP, dependency review, URL validation, and DOMPurify reduce that attack surface but do not turn browser storage into a hardware vault.

Browser deletion is logical deletion. It is not guaranteed forensic erasure from SSD wear leveling, filesystem snapshots, browser sync, backups, crash dumps, or provider-retained copies. Users who need that guarantee must use browser/OS account disposal and storage-management controls appropriate to their threat model.

## Consequences

### Positive

- Application-owned records and record keys contain no plaintext token, crypto-storage key, draft, push capability, Matrix identity, room ID, or event content.
- Remembered sign-in and fast encrypted sync startup remain available.
- Private sessions provide an explicit no-account-persistence path.
- Cleanup produces verifiable per-scope results and survives blocked deletion.
- CSP deployment can be staged independently of encrypted-storage migration.

### Costs and trade-offs

- Device-key encryption adds code and testing without protecting a hostile running origin.
- Private sessions lose automatic sign-in, durable crypto identity, drafts, cached sync, and closed-app push.
- Legacy Rust database names can continue to disclose sanitized user/device identifiers until account sign-out.
- The first migration discards legacy sync state and performs one fresh sync.
- Future Matrix SDK upgrades require compatibility testing against the encrypted store contract.

## Rollout and rollback

Deploy first to preview with CSP_REPORT_ONLY=1 and run login, crypto, sync, draft, push, service-worker, lazy-UI, media, and WebAssembly smoke tests. Remove the flag before production. Keep the flag only as an emergency CSP rollback; it must not disable encrypted persistence.

Do not roll back a migrated origin to a plaintext-only session build. Roll forward or deploy a storage-compatible build.

## Enforcement and verification

- Key and envelope primitives: lib/matrix/private-storage.ts
- Session validation and migration: lib/matrix/session-store.ts
- Encrypted SDK store and drafts: lib/matrix/encrypted-store.ts
- Push persistence: lib/matrix/push-store.ts, lib/matrix/notifications.ts, public/sw.js
- Cleanup coordination: lib/matrix/storage-cleanup.ts
- CSP and headers: proxy.ts, next.config.ts
- Sanitization boundary: lib/matrix/normalize.ts
- Storage, migration, and cleanup tests: tests/private-storage.test.ts
- Service-worker tests: tests/service-worker.test.ts
- Production header and CSP tests: tests/security-browser/security.spec.ts
- Release gates: npm run check, npm run test:security

## Related decisions

- [ADR-0003](./0003-matrix-client-boundary.md)
- [ADR-0008](./0008-privacy-minimal-web-push.md)
- [ADR-0010](./0010-pwa-and-service-worker.md)
- [ADR-0012](./0012-dependency-governance.md)
- [ADR-0014](./0014-security-and-data-minimization.md)
