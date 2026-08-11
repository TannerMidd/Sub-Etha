# ADR-0010: Use a conservative app-shell service worker

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: installation, offline shell, updates, push handling, and cache ownership

## Context

Sub-Etha should be installable and able to open its shell during transient network failure. It also needs a service worker for closed-app Web Push. Aggressive caching is dangerous for a security-sensitive messaging client because it can serve stale application code, cache private API responses, or complicate update recovery.

## Decision

Use one explicit service worker for the small static app shell and push lifecycle. Precache the root, manifest, and application icons. Use network-first navigation with a cached root only as an offline fallback. Cache same-origin static JavaScript, CSS, image, icon, and manifest responses on demand.

Never intercept or cache `/api/`, `/_matrix/`, or `/_vinext/` requests. Version the shell cache, delete old versions during activation, claim clients, and expose an explicit `SKIP_WAITING` update path controlled by the application UI.

### Required invariants

- Matrix, push API, and runtime protocol responses are never placed in the shell cache.
- Navigation prefers current network content when available.
- Offline fallback is the application shell, not fabricated Matrix state.
- Cache names change when shell-cache behavior or incompatible assets change.
- Old owned caches are removed during activation.
- Update activation is visible and recoverable through the application lifecycle.
- Push configuration is stored in service-worker-accessible IndexedDB and cleared on disable or logout.
- Push payloads remain generic under ADR-0008.

## Consequences

### Positive

- The app remains installable and can launch during brief network outages.
- Cache scope is small and easy to audit.
- One worker coordinates installation, updates, badging, notification dismissal, and push challenges.

### Costs and trade-offs

- Offline use does not include fresh or fully browsable Matrix history.
- Developers must bump or manage cache versions when cache behavior changes.
- Service-worker lifecycle races require browser-level testing.

## Alternatives considered

### Cache-first navigation

This improves offline startup but can keep users on stale security-sensitive application code.

### Workbox or a generated service worker

It offers richer strategies but adds abstraction for a deliberately small cache policy and can make exclusions less obvious.

### No service worker

This removes lifecycle complexity but loses installation, offline shell fallback, and closed-app notifications.

## Enforcement and verification

- Worker policy: `public/sw.js`
- Registration and update UI: `lib/matrix/notifications.ts`, `app/components/SubEthaApp.tsx`
- Manifest: `public/manifest.webmanifest`
- PWA and push browser tests: `tests/browser/`

## Revisit when

- Offline room history becomes a product requirement.
- A generated worker can prove equivalent exclusions and update control with less maintenance.
- Browser installation or push standards materially change.

## Related decisions

- [ADR-0004](./0004-client-storage-and-tab-ownership.md)
- [ADR-0008](./0008-privacy-minimal-web-push.md)
- [ADR-0014](./0014-security-and-data-minimization.md)
