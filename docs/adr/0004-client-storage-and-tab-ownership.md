# ADR-0004: Keep private session state client-side and enforce one active tab

- Status: Superseded by ADR-0015
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: browser persistence, account lifecycle, and concurrency

## Context

A Matrix client must persist an access token, device identity, and a secret used by the SDK's crypto storage. Those values are sensitive and must not be copied into the Sub-Etha backend. At the same time, opening the same account in multiple tabs can create competing sync and crypto ownership, excess resource use, and confusing state transitions.

Not all browser state has equal lifetime: login transactions are tab-scoped, preferences and drafts are origin-scoped, and service-worker push configuration must be available when no page is open.

## Decision

Persist the Matrix session and random 32-byte Base64URL crypto storage key in the `sub-etha-session` IndexedDB database. Keep pending OAuth and SSO transaction state in `sessionStorage`; keep non-server preferences, drafts, and local push capabilities in `localStorage`; keep service-worker push configuration in its own IndexedDB store.

Allow only one active tab to own the live Matrix client. Prefer the Web Locks API and use the existing local-storage takeover signal for explicit recovery and communication. A competing tab shows a duplicate-session state instead of silently starting another client.

### Required invariants

- Matrix access tokens and crypto keys never enter server persistence or logs.
- New sessions receive cryptographically random storage keys.
- Pending redirect state is consumed and removed after callback handling.
- Logout clears browser session and push state in a defined order.
- A tab must acquire account ownership before starting sync.
- Takeover is explicit and recoverable; stale ownership must not permanently lock out the user.
- Storage failures surface as actionable application state rather than partial silent login.

## Consequences

### Positive

- Sensitive account data stays within the browser and selected homeserver relationship.
- One owner reduces crypto-store contention and duplicate sync.
- Storage lifetime matches the state being persisted.

### Costs and trade-offs

- Users cannot intentionally run the same Sub-Etha account in multiple tabs.
- Clearing site data removes the local session and device state.
- Browser storage and lock APIs require recovery paths for private mode, quota failures, and abrupt tab termination.

## Alternatives considered

### Store sessions in server cookies

This would make the backend responsible for Matrix credentials and undermine the privacy model.

### Permit one Matrix client per tab

This is simpler locally but creates concurrency and resource problems and makes notification and read-state ownership ambiguous.

### Put all browser state in localStorage

It is synchronous, poorly suited to crypto/session material, shared across tabs, and unavailable to the service worker in the required form.

## Enforcement and verification

- Session encoding and IndexedDB: `lib/matrix/session-store.ts`
- Ownership and takeover: `lib/matrix/client.ts`, `app/components/SubEthaApp.tsx`
- Redirect state: `lib/matrix/auth.ts`
- Service-worker storage: `public/sw.js`
- Storage and auth unit tests: `tests/*.test.ts`

## Revisit when

- The Matrix SDK formally supports safe shared-worker ownership across tabs.
- Multi-account or multi-tab operation becomes a product requirement.
- The browser platform offers a stronger portable credential-storage primitive.

## Related decisions

- [ADR-0003](./0003-matrix-client-boundary.md)
- [ADR-0008](./0008-privacy-minimal-web-push.md)
- [ADR-0014](./0014-security-and-data-minimization.md)
- [ADR-0015](./0015-encrypted-browser-persistence-and-csp.md)
