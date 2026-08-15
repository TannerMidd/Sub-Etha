# ADR-0021: Keep the PWA worker cache-free with an inert offline response

- Status: Accepted
- Date: 2026-08-15
- Supersedes: PWA caching portion of ADR-0019

## Context

The service worker must support closed-app push without becoming a replay layer for authenticated HTML, nonces, or private Matrix state. Worker-owned cached application assets would also make update and failure behavior depend on stale Cache Storage entries. The browser may still use its ordinary HTTP cache; this decision concerns worker-owned Cache Storage and replay.

## Decision

Keep the service worker cache-free for application and static assets:

- Do not write or replay Cache Storage entries for the shell or static assets.
- Handle navigations network-first. If navigation fails, return a newly constructed inert 503 response with `Cache-Control: no-store`, restrictive CSP, and no application state.
- Let the browser's HTTP cache operate normally for requests the worker does not intercept.
- Keep push display, subscription challenge, and push-subscription renewal in the worker; this decision does not remove closed-app notifications.
- Keep activation of an explicitly surfaced waiting update application-controlled. Cache removal or update prompts must not become a substitute for that decision.

## Consequences

- Reloads and navigations require the network to load the application shell; offline Matrix history is not provided.
- Authenticated HTML, nonces, and private application state cannot be replayed from worker-owned Cache Storage.
- The worker remains small and focused on push plus a safe offline failure response.
- Installability and closed-app notifications remain available, while offline shell behavior is intentionally unavailable.

## Revisit when

- A cache-backed offline experience can preserve authenticated-content, nonce, update, and privacy invariants without replaying stale private state.
- Product requirements make offline application navigation a priority and provide an explicit data-ownership design.
