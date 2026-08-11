# ADR-0020: Minimize data and bound untrusted work

- Status: Accepted
- Date: 2026-08-11
- Supersedes: ADR-0007 and ADR-0014

## Context

Sub-Etha handles credentials, stored browser state, remote events, formatted HTML, media, redirect URLs, network destinations, push capabilities, and user-controlled files. TypeScript types do not validate data that arrives from a network, browser store, or file.

## Decision

Treat privacy, boundary validation, and bounded work as cross-cutting design constraints:

- Apply runtime validation where untrusted values affect navigation, rendered HTML, external network destinations, server persistence, or resource-intensive downloads. TypeScript types and declared file metadata are not proof of validity.
- Sanitize formatted Matrix content before rendering it as HTML.
- Keep authenticated Matrix media between the browser and homeserver; do not proxy it through Sub-Etha.
- Give remotely influenced work risk-appropriate byte, item, dimension, concurrency, time, rate, capacity, and retention limits.
- Introduce server persistence only for an allowlisted operational need with a declared purpose, retention period, deletion path, and privacy impact.
- Keep secrets out of logs and error responses; use random bearer capabilities and hash them at rest when server lookup is required.

Concrete limits, sanitizers, accepted formats, and compatibility fallbacks belong in code and tests. Changing a value is normal maintenance unless it changes the trust boundary or security posture; changing the underlying boundary requires an ADR.

## Consequences

- Malformed or abusive input has bounded impact.
- Privacy claims are supported by data flow and schema restrictions rather than access policy alone.
- Some legitimate extreme inputs may be rejected and require clear user-facing failure states.
- Security-sensitive boundary code requires focused tests and explicit cleanup behavior.

## Revisit when

- A feature proposes a new server-side data category or external integration.
- A product requirement changes where Matrix credentials, identity, media, or content are processed.
- Measurements show that existing resource policies are unsuitable and changing them would alter the risk posture.

Browser ownership is defined by [ADR-0017](./0017-browser-owned-matrix-boundary.md); the push exception is defined by [ADR-0019](./0019-privacy-minimal-push-and-pwa.md).
