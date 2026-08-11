# ADR-0014: Treat privacy and bounded work as cross-cutting constraints

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: trust boundaries, validation, data collection, retention, and resource limits

## Context

A messaging client handles credentials, encrypted data, untrusted event content, remote media, redirect URLs, network destinations, push capabilities, and user-controlled files. Security cannot be isolated in one module because a change in UI, media, authentication, persistence, or deployment can expand the trust boundary.

The strongest privacy property is architectural: Sub-Etha infrastructure does not receive or store Matrix identities or content. The strongest availability property is similarly structural: work influenced by remote input is explicitly bounded.

## Decision

Use data minimization and bounded work as design constraints for every layer. Keep Matrix credentials, identities, content, and decryption in the browser. Introduce server persistence only for a documented operational need and record its fields, retention, access capability, and cleanup path.

Validate at trust boundaries rather than relying on TypeScript types for network or stored input. Sanitize formatted Matrix HTML, constrain navigation URLs and homeserver schemes, validate external push destinations against hostname and public-IP policy, inspect media bytes, and use cryptographically random capability material.

Every remote-input path must define applicable limits for bytes, item counts, dimensions, concurrency, time, rate, capacity, and retention. Failure must be explicit, user-safe, and must not silently weaken the boundary.

### Required invariants

- The Sub-Etha backend does not receive or persist Matrix access tokens, encryption keys, user IDs, room IDs, sender names, room names, or message content.
- HTTPS is required for non-loopback homeservers and external service destinations.
- Redirect and metadata URLs are validated before navigation or trust.
- Matrix formatted HTML is sanitized before rendering.
- Secrets and bearer capabilities are not logged and are hashed at rest when server lookup is required.
- Remote media and push work remain within documented resource budgets.
- New persisted fields declare purpose, retention, deletion, and whether they cross a privacy boundary.
- Errors avoid reflecting secrets or unnecessary remote payload content.
- Security limits are covered by unit tests wherever the logic is deterministic.

## Consequences

### Positive

- Privacy claims are supported by data flow rather than policy alone.
- Abuse and malformed input have bounded operational impact.
- Reviewers have a common checklist across otherwise unrelated modules.
- Breach impact is reduced because the backend lacks Matrix content and identity mappings.

### Costs and trade-offs

- Rich closed-app notifications and server-side search or analytics are intentionally unavailable.
- Compatibility exceptions require explicit policy rather than permissive fallback.
- Limits can reject legitimate extreme inputs and must produce clear UI.
- Security tests and cleanup code add maintenance work.

## Alternatives considered

### Rely on the homeserver as the only trust boundary

Homeservers are remote and events, media, and metadata can still be malicious or malformed from the client's perspective.

### Collect data now and restrict access by policy

Access controls help, but data that is never collected cannot be leaked, queried, retained accidentally, or subpoenaed from Sub-Etha.

### Add limits only after observed abuse

Reactive limits leave availability controlled by remote input and make emergency policy changes harder to validate.

## Enforcement and verification

- Auth and URL policy: `lib/matrix/auth.ts`, `lib/matrix/url-policy.ts`
- Sanitization and event normalization: `lib/matrix/normalize.ts`
- Media budgets: `lib/matrix/media.ts`, `lib/matrix/client.ts`
- Push validation and limits: `lib/push-gateway.ts`, `lib/push-server.ts`
- Permitted server schema: `db/schema.ts`
- Service-worker cache exclusions: `public/sw.js`
- Boundary tests: security, media, auth, and push files in `tests/`

## Revisit when

- A product requirement would move Matrix data or credentials into Sub-Etha infrastructure.
- A new external integration or persistent data category is proposed.
- Measured workloads require changed limits or retention.
- A platform primitive can materially reduce the trusted code or stored data.

## Related decisions

- [ADR-0004](./0004-client-storage-and-tab-ownership.md)
- [ADR-0007](./0007-media-security-and-caching.md)
- [ADR-0008](./0008-privacy-minimal-web-push.md)
- [ADR-0009](./0009-neon-drizzle-persistence.md)
- [ADR-0010](./0010-pwa-and-service-worker.md)
- [ADR-0015](./0015-encrypted-browser-persistence-and-csp.md)
