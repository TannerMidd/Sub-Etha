# Sub-Etha

Sub-Etha is a fast, installable Matrix client with Rust-backed end-to-end encryption, IndexedDB persistence, virtualized timelines, authenticated media, and a privacy-minimal Web Push gateway hosted on Vercel.

Matrix access tokens, encryption keys, message bodies, sender names, room names, and synced history remain between the browser and the selected Matrix homeserver. The deployment backend stores only separately hashed delivery and browser-management capabilities, Web Push subscription material, short-lived endpoint-confirmation challenges, timestamps, aggregate gateway counters, and seven-day delivery-deduplication records. It does not store Matrix identities or client IP addresses.

## Browser privacy and storage

Remembered sessions are the default. Sub-Etha encrypts the complete session, Matrix sync cache, drafts, and push capabilities in IndexedDB with origin-bound, non-extractable Web Crypto keys. Account database names are random and room/user identifiers are HMAC-derived before they become record keys. Private sessions are optional and persist none of that account state; reloading requires authentication and closed-app push is unavailable.

This device encryption improves resistance to offline copies of browser databases. It is not guaranteed hardware-backed and cannot protect data from malicious same-origin JavaScript while the app is running, a browser compromise, extensions with sufficient access, or malware. The nonce-based Content Security Policy and mandatory DOMPurify boundary reduce web-content risk but do not change those limits. Sign-out performs account-scoped logical deletion; **Erase all Sub-Etha data** removes all managed origin state. Browser deletion is not guaranteed forensic erasure from SSDs, browser backups, or sync systems.

See [Browser storage and privacy](./docs/privacy-and-browser-storage.md) for the complete threat model and erasure semantics.

## Architecture

Start with the [architecture map](./docs/architecture.md), then use the [ADR index](./docs/adr/README.md) for the decisions, constraints, trade-offs, and enforcement anchors behind the stack. New cross-cutting or difficult-to-reverse changes should follow the ADR process documented there.

## Local development

Requirements: Node.js 22.13 or later.

```bash
npm ci
npx vercel env pull .env.local --yes
npm run db:migrate
npm run dev
```

The linked Vercel project supplies Neon credentials through `.env.local`. The local URL is printed by Vite. Matrix OAuth requires the deployed HTTPS origin; password, legacy SSO, and access-token login remain available locally when supported by the homeserver.

## Verification

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run build
```

Generate and apply PostgreSQL migrations after changing `db/schema.ts`:

```bash
npm run db:generate
npm run db:migrate
```

## Vercel production configuration

Provision Neon from the Vercel Marketplace and configure these production values before enabling closed-app notifications:

- `DATABASE_URL` and `DATABASE_URL_UNPOOLED` (injected by Neon)
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT=https://sub-etha-matrix.vercel.app`
- `PUSH_ENDPOINT_HOSTS` for comma-separated, exact additional provider hostnames (optional)
- `PUSH_MAX_SUBSCRIPTIONS=10000`
- `PUSH_REGISTRATION_LIMIT_PER_10M=300`
- `PUSH_TEST_LIMIT_PER_MIN=60`
- `PUSH_NOTIFY_LIMIT_PER_MIN=600`
- `PUSH_DELIVERY_LIMIT_PER_MIN=3000`

Invalid or non-positive numeric overrides use the documented defaults. Apply database migrations before deploying application code because registration and global budgets rely on the singleton gateway tables and database functions.

The gateway endpoints are:

- `GET /api/push/vapid-key`
- `POST /api/push/subscriptions`
- `PATCH /api/push/subscriptions` (encrypted endpoint-challenge confirmation)
- `DELETE /api/push/subscriptions`
- `POST /api/push/test`
- `POST /_matrix/push/v1/notify`

The Matrix pusher uses `event_id_only` and receives only the delivery identifier. Browser test and removal operations require a separate management capability that is never sent to the homeserver. A new endpoint does not count toward active capacity until its service worker returns an encrypted Web Push challenge. Notifications are deliberately generic; opening Sub-Etha fetches and decrypts the event directly from the homeserver. Push is intentionally unavailable on Vercel preview deployments.

Automatic media previews are capped at 64 MiB of transferred bytes and 64 MiB of decoded RGBA work per image or animation, with a 16,384-pixel maximum edge. Three downloads may run concurrently; each has a 10-second idle deadline and a 30-second total deadline. Animated images remain paused behind a generated static poster until the user explicitly plays them.

The Vercel Firewall must rate-limit `/api/push/subscriptions` and `/api/push/test` together to 60 requests per 600 seconds per IP. Do not include the Matrix callback in that IP rule; its application-level global budget is shared without storing homeserver or client identities. Stage the rule in log mode, inspect its matches, verify it on preview, and have the project owner publish it after review.
