# ADR-0019: Keep push privacy-minimal and PWA caching conservative

- Status: Accepted for push/privacy scope; PWA caching scope superseded by ADR-0021
- Date: 2026-08-11
- Supersedes: ADR-0008, the push portion of ADR-0009, and ADR-0010
- Superseded by: ADR-0021 (PWA caching portion only)

## Context

Closed-app Matrix notifications require a server-side Web Push gateway and a service worker. That path must not become a second Matrix data store, a rich-notification content processor, an SSRF primitive, or a cache of private application traffic.

## Decision

Operate a privacy-minimal Matrix push gateway:

- Give the homeserver a delivery capability and keep a separate browser-management capability.
- Store lookup capabilities only as hashes and prove control of a new Web Push endpoint before activation.
- Validate push destinations against an approved HTTPS and public-network policy.
- Keep visible notification text generic; the browser retrieves and decrypts the event after opening.
- Bound request bodies, device fan-out, registration, capacity, and delivery rates. Give deduplication and subscription records finite retention, with atomic persistence where concurrency matters.

The gateway may transiently receive the Matrix `room_id`, `event_id`, and unread counts required by the push flow. It may retain an event ID for bounded delivery deduplication. It does not persist room IDs, Matrix user IDs, sender or room names, message content, access tokens, or client IP addresses.

Use one service worker for push handling and a minimal offline application shell. Navigation is network-first. Only public shell and static responses are eligible for caching. The current worker enforces this through same-origin, path-prefix, and static-extension rules rather than by inspecting authentication or cache headers, so every new private route space requires an explicit exclusion. Offline fallback opens the application shell and never fabricates Matrix state. The connected UI exposes waiting updates through an application-controlled reload; other boot states rely on the browser lifecycle rather than an in-app update prompt.

Provider lists, route paths, cache names, precached assets, timeouts, rates, and retention durations belong in code, configuration, and tests.

## Consequences

- Closed-app notifications do not reveal sender, room, or message text in their visible content.
- The backend still handles narrowly defined encrypted-push metadata and subscription material.
- Rich offline history and rich closed-app notifications are intentionally unavailable.
- Endpoint validation, cleanup, and service-worker lifecycle handling add complexity.

## Revisit when

- Matrix and Web Push provide an end-to-end encrypted rich-notification design with equivalent metadata privacy.
- Offline room history becomes a product requirement.
- Push scale requires a durable queue or a separate service tier.

## Relationship update

ADR-0021 supersedes the PWA caching portion of this record. The service-worker caching paragraph above is retained as historical rationale; current behavior does not write or replay Cache Storage entries or provide an offline application shell. The privacy-minimal push decision remains accepted and active.
