# Architecture

Sub-Etha is a browser-first Matrix client. The browser owns Matrix authentication, sync, end-to-end encryption, decrypted room state, media access, and interactive application state. The deployment backend is intentionally limited to serving the application and operating a privacy-minimal Web Push gateway.

The authoritative decisions behind this architecture are recorded in [the ADR index](./adr/README.md). This document is the map; the ADRs explain why the boundaries exist, what they cost, and how they are enforced.

## System context

```text
┌──────────────────────────────── Browser ────────────────────────────────┐
│ React UI                                                                │
│   ↕ useSyncExternalStore                                                │
│ MatrixService ── Matrix Client-Server API ── Matrix homeserver           │
│   ↕                                                                       │
│ IndexedDB: session + crypto key          Service worker: shell + push    │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ generic Web Push subscription lifecycle
                               ▼
┌──────────────────── Sub-Etha deployment boundary ───────────────────────┐
│ Vinext/Vite/Nitro application                                           │
│ Push route handlers → push service/repository → Neon PostgreSQL          │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ encrypted Web Push delivery
                               ▼
                      Approved push provider
```

Message bodies, room names, sender names, Matrix user identifiers, access tokens, encryption keys, and synced history do not cross into the Sub-Etha backend. Notifications are generic; the browser opens the app and retrieves and decrypts the event from its homeserver.

## Module boundaries

| Boundary            | Responsibility                                                             | Primary locations                                  |
| ------------------- | -------------------------------------------------------------------------- | -------------------------------------------------- |
| Application shell   | Boot state, login and connected transitions, PWA lifecycle, theme fallback | `app/components/SubEthaApp.tsx`                    |
| UI composition      | Rooms, timeline, composer, dialogs, responsive navigation                  | `app/components/`                                  |
| Styling system      | Semantic tokens, shared primitives, component-scoped presentation          | `app/styles/`, `app/styles/*.module.scss`          |
| Matrix adapter      | SDK lifecycle, normalized external-store snapshot, commands, crypto, media | `lib/matrix/`                                      |
| Timeline policy     | Attachment state, change classification, prepend geometry                  | `lib/timeline-scroll.ts`, `lib/timeline-window.ts` |
| Push HTTP adapter   | Request and response validation and route mapping                          | `app/api/`                                         |
| Push domain/service | Limits, capability validation, delivery policy, cleanup                    | `lib/push-server.ts`, `lib/push-gateway.ts`        |
| Push persistence    | Repository contract and Neon/Drizzle implementation                        | `lib/push-repository.ts`, `db/`                    |
| PWA worker          | Shell cache, generic push display, subscription challenge                  | `public/sw.js`                                     |

Dependencies should point inward toward contracts and pure policy where practical. UI components may call the Matrix adapter, but they must not use Matrix SDK event objects as their view model. Route handlers may call the push service, but business rules must not be duplicated in the handlers.

## Runtime and data flow

1. `app/page.tsx` mounts `SubEthaApp`.
2. The app reads the persisted Matrix session from IndexedDB and dynamically starts the Matrix client in the browser.
3. `MatrixService` normalizes SDK state into a typed `MatrixSnapshot`.
4. React consumes that snapshot with `useSyncExternalStore`; user commands return through the service instead of mutating the snapshot.
5. Timeline rendering uses React Virtuoso while Sub-Etha owns scroll policy and prepend bookkeeping.
6. Optional Web Push registration gives the homeserver only a delivery capability. The separate management capability remains in the browser.
7. Push callbacks are validated, budgeted, deduplicated, and delivered as generic payloads.

## State ownership

| State                                        | Owner                     | Persistence           |
| -------------------------------------------- | ------------------------- | --------------------- |
| Matrix session and crypto storage key        | Browser                   | IndexedDB             |
| Encryption store and sync state              | Matrix SDK in the browser | SDK-managed IndexedDB |
| Active Matrix snapshot                       | `MatrixService`           | Memory                |
| Component-local interaction state            | React component           | Memory                |
| Composer drafts, theme, push capabilities    | Browser                   | `localStorage`        |
| Pending OAuth or SSO transaction             | Browser tab               | `sessionStorage`      |
| Service-worker push configuration            | Service worker            | IndexedDB             |
| Push subscriptions, budgets, delivery leases | Push gateway              | Neon PostgreSQL       |

New state must have one declared owner. Mirrored state needs a documented synchronization rule; otherwise it should be derived at the consumer.

## Change rules

A change requires a new or superseding ADR when it:

- changes a runtime, framework, database, hosting, or package-management foundation;
- moves Matrix data or credentials across the browser/server privacy boundary;
- changes the `MatrixService` snapshot and command model or single-tab ownership model;
- changes timeline virtualization or scroll-state semantics;
- introduces a new persistent data category or externally reachable service;
- changes styling encapsulation or makes generated class names a behavior contract;
- weakens a quality gate, supported viewport, security limit, or deployment ordering rule.

Small implementation choices that remain inside an accepted boundary belong in code comments, tests, or normal review rather than an ADR.

## Verification

The local release gate is:

```bash
npm run check
```

That runs formatting checks, linting, strict TypeScript, unit tests, a production build, and the Playwright browser suite. Database schema changes additionally require a generated Drizzle migration and an apply-before-deploy plan.
