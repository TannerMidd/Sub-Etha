# Architecture

Sub-Etha is a browser-first Matrix client with a narrow deployment backend. This document describes the current system. The [active ADRs](./adr/README.md#active-decisions) preserve rationale for the few boundaries that are costly to change; [code conventions](./code-conventions.md) govern routine development.

## Governing rules

1. **Matrix is browser-owned.** The supported application flow handles authentication, sync, end-to-end encryption, decryption, message content, private media, and account persistence in the browser and selected homeserver.
2. **Matrix behavior stays behind the adapter.** UI components consume normalized fields and commands; opaque SDK handles currently carried on application records are for adapter use and are not inspected or called by UI code. Shared or persisted state has one declared owner.
3. **The backend has one narrow exception.** It serves the app and operates generic Web Push. Minimal push identifiers may transit that path, but supported contracts do not request, use, log, or persist Matrix credentials or content, and persisted push data is explicitly allowlisted.
4. **Untrusted work is validated and bounded.** Runtime checks protect navigation, rendered HTML, external destinations, server persistence, and resource-intensive downloads; TypeScript types and declared metadata are not validation. Remotely influenced work has risk-appropriate resource and retention limits.
5. **Timeline windowing preserves the reader.** Rendering remains bounded without moving a detached reader or losing the visible anchor when history is prepended.
6. **The service worker is limited to the public shell and static assets.** Its current same-origin, path, and extension rules require an explicit exclusion whenever a new private route space is added. It is not an offline Matrix data store.
7. **Database changes remain rollout-compatible.** Required additive schema is applied before dependent code; destructive contraction waits until older code is gone.

## System context

```text
┌──────────────────────────────── Browser ────────────────────────────────┐
│ React UI                                                                │
│   ↕ application snapshot and commands                                  │
│ Matrix adapter ── Matrix Client-Server API ── Matrix homeserver          │
│   ↕                                                                       │
│ IndexedDB: account and crypto state      Service worker: shell + push    │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ privacy-minimal Web Push lifecycle
                               ▼
┌──────────────────── Sub-Etha deployment boundary ───────────────────────┐
│ Vinext/Vite/Nitro application                                           │
│ Push routes → push service/gateway → repository → Neon PostgreSQL        │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ encrypted Web Push delivery
                               ▼
                      Approved push provider
```

The push callback can transiently carry `room_id`, `event_id`, and unread counts. The database retains an event ID only for bounded deduplication. Room IDs, Matrix user IDs, sender and room names, message content, access tokens, encryption keys, synced history, and client IP addresses are not persisted by Sub-Etha. Notification text remains generic; the browser retrieves and decrypts the event from its homeserver.

## Module boundaries

| Boundary          | Responsibility                                                            | Primary locations                                  |
| ----------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Application shell | Boot, login and connected transitions, PWA lifecycle, theme fallback      | `app/components/SubEthaApp.tsx`                    |
| UI composition    | Rooms, timeline, composer, dialogs, responsive navigation                 | `app/components/`                                  |
| Styling           | Semantic tokens, shared primitives, component-scoped presentation         | `app/styles/`                                      |
| Matrix adapter    | SDK lifecycle and behavior, application snapshot, commands, crypto, media | `lib/matrix/`                                      |
| Timeline policy   | Change classification, attachment state, prepend geometry                 | `lib/timeline-scroll.ts`, `lib/timeline-window.ts` |
| Push routes       | Framework route and method entry points                                   | `app/api/`                                         |
| Push service      | HTTP validation and responses, capabilities, budgets, delivery, cleanup   | `lib/push-server.ts`                               |
| Push gateway      | Push payload shaping and destination network policy                       | `lib/push-gateway.ts`                              |
| Push persistence  | Repository contract and Neon/Drizzle implementation                       | `lib/push-repository.ts`, `db/`                    |
| PWA worker        | Shell cache, generic push display, subscription challenge                 | `public/sw.js`                                     |

Framework routes delegate requests without duplicating push policy. UI code may invoke the Matrix adapter, but Matrix SDK behavior remains inside `lib/matrix`. Pure policy is kept separate where that provides a useful test seam; a particular helper or repository shape is not itself an architectural invariant.

## State ownership

| State                                            | Owner                     | Persistence           |
| ------------------------------------------------ | ------------------------- | --------------------- |
| Matrix session and crypto storage key            | Browser Matrix adapter    | IndexedDB             |
| Encryption store and sync state                  | Matrix SDK in the browser | SDK-managed IndexedDB |
| Active application snapshot                      | Matrix adapter            | Memory                |
| Component interaction state                      | Owning React component    | Memory                |
| Drafts, theme, authoritative push capabilities   | Browser application       | `localStorage`        |
| Pending OAuth or SSO transaction                 | Browser tab               | `sessionStorage`      |
| Worker-side push configuration replica           | Service worker            | IndexedDB             |
| Push subscriptions, budgets, and delivery leases | Push service/repository   | Neon PostgreSQL       |

Page-side push capabilities are authoritative. Enabling or reconciling push sends `SET_PUSH_CONFIG` to the worker replica; disable and logout send `CLEAR_PUSH_CONFIG`. The replica exists so the worker can handle subscription lifecycle while no page is open. Other mirrored state needs an explicit synchronization rule; otherwise consumers derive it from the owner.

## When architecture documentation changes

Update this map whenever module responsibility, state ownership, or a data flow changes. Create a new ADR only when the change meets the admission rule in the [ADR index](./adr/README.md#when-an-adr-is-warranted), such as moving a trust boundary, replacing a foundational runtime or service, changing an external contract, or adopting a different ownership model.

Libraries, constants, file paths, styling details, test matrices, and routine refactors remain code, configuration, test, or review concerns unless they change one of those boundaries.
