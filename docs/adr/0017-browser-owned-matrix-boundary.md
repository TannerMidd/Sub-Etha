# ADR-0017: Keep Matrix state and behavior browser-owned

- Status: Accepted
- Date: 2026-08-11
- Supersedes: ADR-0003 and ADR-0004

## Context

The Matrix SDK exposes mutable clients, events, rooms, sync state, and encryption state. Sending Matrix traffic through Sub-Etha infrastructure would turn the backend into a credential and content processor. Allowing UI components to depend on SDK behavior would spread lifecycle and race semantics throughout the application.

## Decision

The browser owns Matrix authentication, sync, end-to-end encryption, decryption, private media access, and persisted account state. Supported Sub-Etha backend contracts do not request, use, log, or persist Matrix credentials, encryption keys, message content, or synced history.

Keep SDK lifecycle and behavior inside the Matrix adapter in `lib/matrix`. UI components consume normalized fields and invoke adapter commands; they must not inspect or call Matrix SDK objects. The current exported application records carry opaque `Room` and `MatrixEvent` handles for adapter commands, so this boundary is enforced by usage and review rather than by the type system. Those handles should be replaced by an adapter-owned lookup if UI code would otherwise need them.

Each shared or persisted state category has one declared owner. The target concurrency model is one live Matrix client per account and origin. Browsers with reliable cross-tab locking enforce exclusive ownership; compatibility fallbacks must be documented as best effort and keep takeover explicit.

Storage technology, database names, key encoding, React subscription hooks, and takeover signaling are implementation choices as long as the ownership and privacy boundaries remain intact.

## Consequences

- The UI is insulated from most Matrix SDK churn and mutable event semantics.
- Sensitive account data stays within the browser and chosen homeserver relationship.
- Matrix features require an application-facing model or command instead of direct SDK use in components.
- Reliable multi-tab or multi-account operation requires a new ownership design.

## Revisit when

- Multi-account or concurrent multi-tab operation becomes a product requirement.
- The Matrix SDK provides a stable application-state boundary that can replace the adapter.
- A product requirement proposes sending Matrix credentials or content through Sub-Etha infrastructure.

The separate minimal push exception is governed by [ADR-0019](./0019-privacy-minimal-push-and-pwa.md).
