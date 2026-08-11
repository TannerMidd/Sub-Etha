# ADR-0008: Operate a privacy-minimal Web Push gateway

- Status: Superseded by ADR-0019
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: closed-app notifications, server trust boundary, capabilities, SSRF, and rate limits

## Context

A browser cannot receive Matrix events while closed without a push service. A traditional notification gateway can learn user, room, sender, and message data, and a public push endpoint can be abused for SSRF or resource exhaustion. Sub-Etha's privacy promise requires a narrower design.

## Decision

Operate an `event_id_only` Matrix push gateway. Give the homeserver a random delivery capability and keep a separate browser-management capability for testing and removal. Store only hashes of those capabilities. Confirm new browser endpoints through an encrypted Web Push challenge before counting them as active.

Accept only minimal Matrix notification identifiers, send generic notification payloads, and let the browser retrieve and decrypt the event after the app opens. Validate push endpoints against an approved provider policy and public DNS resolution. Apply request limits, global and per-subscription delivery budgets, deduplication leases, capacity limits, and stale-record cleanup.

Disable push on Vercel preview deployments.

### Required invariants

- The gateway never stores Matrix user IDs, room IDs, sender names, room names, message bodies, access tokens, or client IP addresses.
- The homeserver receives only the delivery capability, never the management capability.
- Capability values are random and stored only as hashes server-side.
- Endpoint registration is not active until the service worker returns the challenge.
- Notification text is generic and cannot reveal Matrix content.
- Push destinations use HTTPS, approved hosts, and public-IP DNS results.
- Request bodies, device counts, delivery rate, global rate, retention, and subscription capacity are bounded.
- Delivery is deduplicated by capability hash and event ID with recoverable leases.

## Consequences

### Positive

- Closed-app notifications are possible without making the backend a Matrix data processor.
- Separate capabilities limit the authority disclosed to homeservers.
- Challenge confirmation prevents arbitrary endpoint enrollment.
- SSRF and abuse protections are part of the service design rather than perimeter assumptions.

### Costs and trade-offs

- Notifications cannot show sender, room, or message previews while the app is closed.
- Registration and repair require a multi-step browser and service-worker flow.
- Provider allowlisting and DNS validation need maintenance as browser vendors evolve.
- Push availability depends on VAPID, Neon, provider delivery, and service-worker support.

## Alternatives considered

### Send full Matrix notification payloads

This offers richer notifications but exposes Matrix metadata and potentially content to Sub-Etha infrastructure.

### Use one capability for delivery and management

This is simpler but grants the homeserver authority to test or delete the browser subscription.

### Direct homeserver-to-browser notifications without a gateway

Standard Web Push requires application-server credentials and subscription handling that browsers cannot safely expose directly to arbitrary homeservers.

## Enforcement and verification

- Client lifecycle: `lib/matrix/notifications.ts`
- Service policy and limits: `lib/push-server.ts`
- Endpoint and payload safety: `lib/push-gateway.ts`
- Persistence contract: `lib/push-repository.ts`
- HTTP routes: `app/api/push/`, `app/api/matrix-push-notify/`
- Service-worker challenge and generic display: `public/sw.js`
- Unit tests: push-related files in `tests/`

## Revisit when

- The Web Push or Matrix specifications provide an end-to-end encrypted rich-notification standard with equivalent metadata privacy.
- Push must support a provider outside the current safe endpoint policy.
- Scale requires a queue or worker tier beyond request-scoped delivery.

## Related decisions

- [ADR-0009](./0009-neon-drizzle-persistence.md)
- [ADR-0010](./0010-pwa-and-service-worker.md)
- [ADR-0014](./0014-security-and-data-minimization.md)
