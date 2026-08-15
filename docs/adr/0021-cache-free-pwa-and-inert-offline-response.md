# ADR-0021: Keep the PWA worker cache-free with an inert offline response

- Status: Accepted
- Date: 2026-08-15
- Supersedes: PWA caching portion of ADR-0019

## Context

The service worker must support closed-app push without becoming a replay layer for authenticated HTML, nonces, or private Matrix state. Worker-owned cached application assets would also make update and failure behavior depend on stale Cache Storage entries. Production documents and the service worker must bypass HTTP caching; static assets remain safe to cache only because their content hashes give every changed asset a new URL.

## Decision

Keep the service worker cache-free for application and static assets:

- Do not write or replay Cache Storage entries for the shell or static assets.
- Handle navigations with `cache: "no-store"`. If navigation fails, return a newly constructed inert 503 response with `Cache-Control: no-store`, restrictive CSP, and no application state.
- Serve `/sw.js` with `Cache-Control: no-store`, register it with `updateViaCache: "none"`, and stamp its built bytes uniquely on every deployment so app-only changes still trigger a worker update.
- Leave content-hashed static assets unintercepted. Browser caching cannot replay an older version at a changed asset URL.
- Keep push display, subscription challenge, and push-subscription renewal in the worker; this decision does not remove closed-app notifications.
- Activate new workers immediately. Persist whether an install replaces a prior worker, purge every worker-owned Sub-Etha cache during activation, claim the scope, and navigate the previously open same-origin clients onto the fresh network document.
- Do not expose a manual update gate or maintain a second page-side reload path.

## Consequences

- Reloads and navigations require the network to load the application shell; offline Matrix history is not provided.
- Authenticated HTML, nonces, and private application state cannot be replayed from worker-owned Cache Storage.
- Deployments automatically replace running cached-shell clients. This can discard an in-memory draft or interrupt current work, which is accepted in favor of never continuing on a stale application version.
- The worker remains small and focused on push plus a safe offline failure response.
- Installability and closed-app notifications remain available, while offline shell behavior is intentionally unavailable.

## Revisit when

- A cache-backed offline experience can preserve authenticated-content, nonce, update, and privacy invariants without replaying stale private state.
- Product requirements make offline application navigation a priority and provide an explicit data-ownership design.
