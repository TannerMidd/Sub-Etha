# Architecture

Sub-Etha is a browser-first Matrix client with a narrow deployment backend. This document describes the current system. The [active ADRs](./adr/README.md#active-decisions) preserve rationale for the few boundaries that are costly to change; [code conventions](./code-conventions.md) govern routine development.

## Governing rules

1. **Matrix is browser-owned.** The supported application flow handles authentication, sync, end-to-end encryption, decryption, message content, private media, and account persistence in the browser and selected homeserver.
2. **Matrix behavior stays behind the adapter.** UI components consume normalized fields and commands; opaque SDK handles currently carried on application records are for adapter use and are not inspected or called by UI code. Shared or persisted state has one declared owner.
3. **The backend has one narrow exception.** It serves the app and operates generic Web Push. Minimal push identifiers may transit that path, but supported contracts do not request, use, log, or persist Matrix credentials or content, and persisted push data is explicitly allowlisted.
4. **Untrusted work is validated and bounded.** Runtime checks protect navigation, rendered HTML, external destinations, server persistence, and resource-intensive downloads; TypeScript types and declared metadata are not validation. Remotely influenced work has risk-appropriate resource and retention limits.
5. **Timeline windowing preserves the reader.** Rendering remains bounded without moving a detached reader or losing the visible anchor when history is prepended.
6. **The service worker is limited to push and an inert offline response.** It does not write or replay a shell or static-asset cache; navigations are network-first and network failure returns a newly constructed no-store 503 response. It is not an offline Matrix data store.
7. **Database changes remain rollout-compatible.** Required additive schema is applied before dependent code; destructive contraction waits until older code is gone.
8. **Public link previews stay browser-direct and provider-specific.** Eligible public YouTube links may load a lazy thumbnail from the fixed YouTube image CDN. Sub-Etha does not operate an unfurl proxy, and adding another provider requires a new destination and privacy review.

## System context

```text
┌──────────────────────────────── Browser ────────────────────────────────┐
│ React UI                                                                │
│   ↕ application snapshot and commands                                  │
│ Matrix adapter ── Matrix Client-Server API ── Matrix homeserver          │
│ Public YouTube preview ──────────────── HTTPS ── i.ytimg.com             │
│   ↕                                                                       │
│ Matrix MemoryStore      Rust crypto IndexedDB      Service worker: push   │
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

When an eligible lazy YouTube preview enters the viewport, the browser requests a fixed public thumbnail URL directly from `i.ytimg.com`. That request discloses the public video ID and ordinary network metadata to YouTube, but it does not pass through the Sub-Etha backend and does not include Matrix credentials, room or user identifiers, or other message content.

## Module boundaries

| Boundary            | Responsibility                                                            | Primary locations                                  |
| ------------------- | ------------------------------------------------------------------------- | -------------------------------------------------- |
| Application shell   | Boot, login and connected transitions, PWA lifecycle, theme fallback      | `app/components/SubEthaApp.tsx`                    |
| UI composition      | Rooms, timeline, composer, dialogs, responsive navigation                 | `app/components/`                                  |
| Styling             | Semantic tokens, shared primitives, component-scoped presentation         | `app/styles/`                                      |
| Matrix adapter      | SDK lifecycle and behavior, application snapshot, commands, crypto, media | `lib/matrix/`                                      |
| Timeline policy     | Change classification, attachment state, prepend geometry                 | `lib/timeline-scroll.ts`, `lib/timeline-window.ts` |
| Link preview policy | Strict public YouTube parsing, eligibility, layout, and failure bounds    | `lib/youtube-preview.ts`                           |
| Push routes         | Framework route and method entry points                                   | `app/api/`                                         |
| Push service        | HTTP validation and responses, capabilities, budgets, delivery, cleanup   | `lib/push-server.ts`                               |
| Push gateway        | Push payload shaping and destination network policy                       | `lib/push-gateway.ts`                              |
| Push persistence    | Repository contract and Neon/Drizzle implementation                       | `lib/push-repository.ts`, `db/`                    |
| PWA worker          | Generic push display, subscription challenge, inert offline response      | `public/sw.js`                                     |

Framework routes delegate requests without duplicating push policy. UI code may invoke the Matrix adapter, but Matrix SDK behavior remains inside `lib/matrix`. Pure policy is kept separate where that provides a useful test seam; a particular helper or repository shape is not itself an architectural invariant.

## Media resource policy

Matrix media remains browser-to-homeserver and is never proxied through the Sub-Etha backend. The adapter separates upload, receive, image, avatar, queue, and settled-cache budgets instead of treating one number as a universal attachment limit. Current local ceilings are 256 MiB for ordinary unencrypted sends, 128 MiB for encrypted sends and non-image receives, 64 MiB for image messages and previews, and 16 MiB for avatars. A homeserver-advertised upload ceiling lowers the applicable send limit, and a homeserver can still reject an upload independently.

Resource-intensive media work is admitted serially through a bounded count-and-byte queue. Image bytes are signature-validated before image treatment, decoded dimensions and frame rectangles remain bounded, download deadlines cover abortable network work, and settled object-URL caching is capped separately. Native browser, SDK, and cryptographic operations can create additional transient copies and some native work cannot be force-aborted, so these limits bound admitted work rather than guarantee that every device can process a maximum-size attachment without memory pressure.

## State ownership

| State                                            | Owner                   | Persistence                                 |
| ------------------------------------------------ | ----------------------- | ------------------------------------------- |
| Matrix session and crypto storage key            | Browser Matrix adapter  | IndexedDB                                   |
| Matrix sync and timeline store                   | Matrix adapter          | `MemoryStore`; fresh sync after each reload |
| Rust crypto store                                | Matrix SDK              | IndexedDB                                   |
| Active application snapshot                      | Matrix adapter          | Memory                                      |
| Component interaction state                      | Owning React component  | Memory                                      |
| Drafts, theme, authoritative push capabilities   | Browser application     | `localStorage`                              |
| Pending OAuth or SSO transaction                 | Browser tab             | `sessionStorage`                            |
| Worker-side push configuration replica           | Service worker          | IndexedDB                                   |
| Push subscriptions, budgets, and delivery leases | Push service/repository | Neon PostgreSQL                             |

Page-side push capabilities are authoritative. Enabling or reconciling push sends `SET_PUSH_CONFIG` to the worker replica; disable and logout send `CLEAR_PUSH_CONFIG`. The replica exists so the worker can handle subscription lifecycle while no page is open. Other mirrored state needs an explicit synchronization rule; otherwise consumers derive it from the owner.

## When architecture documentation changes

Update this map whenever module responsibility, state ownership, or a data flow changes. Create a new ADR only when the change meets the admission rule in the [ADR index](./adr/README.md#when-an-adr-is-warranted), such as moving a trust boundary, replacing a foundational runtime or service, changing an external contract, or adopting a different ownership model.

Libraries, constants, file paths, styling details, test matrices, and routine refactors remain code, configuration, test, or review concerns unless they change one of those boundaries.
