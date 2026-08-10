# ADR-0003: Isolate Matrix SDK state behind a browser service

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: Matrix integration, application state, React contracts, and testability

## Context

The Matrix SDK exposes mutable clients, rooms, timelines, events, crypto state, and many asynchronous callbacks. Passing those objects through React would couple presentation to SDK internals, produce unstable render contracts, and make sync and decryption races difficult to reason about.

Sub-Etha also needs a deterministic design preview that exercises the real UI without requiring a homeserver account.

## Decision

Keep Matrix SDK ownership in the browser behind `MatrixService`. The service owns client lifecycle and commands, normalizes SDK data into an immutable typed `MatrixSnapshot`, and exposes `subscribe` and `getSnapshot` for React's `useSyncExternalStore`. Components render normalized application types and invoke service methods; they do not treat Matrix SDK objects as view models.

The design preview must satisfy the same application-facing service contract with deterministic local fixture data and remain gated to explicit local preview usage.

### Required invariants

- There is one service owner for a live Matrix client.
- React reads state through `useSyncExternalStore` using referentially stable snapshots between updates.
- `lib/matrix/types.ts` defines presentation-facing Matrix contracts.
- Normalization and HTML sanitization occur before content reaches rendering components.
- Commands return through the service; components do not mutate snapshots.
- SDK event listeners are attached and disposed with the service lifecycle.
- Design-preview data never becomes an authentication or production fallback.

## Consequences

### Positive

- UI components are insulated from Matrix SDK churn.
- Snapshot transitions can be reasoned about and tested as application state.
- The same UI can run against a deterministic preview adapter.
- Security-sensitive normalization has a clear boundary.

### Costs and trade-offs

- `MatrixService` is a large integration module and requires active decomposition as responsibilities grow.
- New Matrix features need both a normalized type and a service command.
- Care is required to avoid rebuilding unchanged snapshots unnecessarily.

## Alternatives considered

### Put SDK objects in React context

This reduces adapter code but spreads mutable SDK semantics and event subscriptions through the component tree.

### Use a general-purpose state-management library

A store library could organize client state, but it would not remove the need to normalize SDK objects and correctly own their lifecycle. The external-store contract is currently sufficient.

### Fetch Matrix through the Sub-Etha backend

This would violate the client-owned encryption and privacy boundary and create a high-value credential service.

## Enforcement and verification

- Service boundary: `lib/matrix/client.ts`
- Contracts: `lib/matrix/types.ts`
- Normalization: `lib/matrix/normalize.ts`
- Consumers: `app/components/SubEthaApp.tsx`, `app/components/ChatShell.tsx`
- Preview adapter: `app/components/DesignPreview.tsx`
- Type and behavior checks: `npm run typecheck`, `npm run test:unit`, `npm run test:browser`

## Revisit when

- Multiple accounts must run concurrently in one browser context.
- The service can no longer provide stable snapshots without unacceptable copying or latency.
- A Matrix SDK upgrade provides a stable immutable application-state adapter that covers Sub-Etha's needs.

## Related decisions

- [ADR-0004](./0004-client-storage-and-tab-ownership.md)
- [ADR-0006](./0006-virtualized-timeline.md)
- [ADR-0014](./0014-security-and-data-minimization.md)
