# Sub-Etha

Sub-Etha is a fast, installable Matrix client with Rust-backed end-to-end encryption, IndexedDB persistence, virtualized timelines, authenticated media, and a privacy-minimal Web Push gateway hosted on Vercel.

Matrix access tokens, encryption keys, message bodies, sender names, room names, and synced history remain between the browser and the selected Matrix homeserver. The deployment backend stores only separately hashed delivery and browser-management capabilities, Web Push subscription material, short-lived endpoint-confirmation challenges, timestamps, aggregate gateway counters, and seven-day event-ID delivery-deduplication records. It does not store Matrix user IDs, room IDs, or client IP addresses.

## Architecture

Start with the [architecture map](./docs/architecture.md), use the [active ADRs](./docs/adr/README.md#active-decisions) for durable rationale, and follow the [codebase conventions](./docs/code-conventions.md) for routine development. New decisions use an ADR only when they meet the narrow admission rule documented in the index.

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
npm run check
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

Of the browser's two capabilities, the Matrix homeserver receives only the delivery capability. With `event_id_only`, its callback carries minimal room, event, and unread-count metadata but no message content. Browser test and removal operations require the separate management capability, which is never sent to the homeserver. A new endpoint does not count toward active capacity until its service worker returns an encrypted Web Push challenge. Notifications are deliberately generic; opening Sub-Etha fetches and decrypts the event directly from the homeserver. Push is intentionally unavailable on Vercel preview deployments.

Automatic media previews are capped at 64 MiB of transferred bytes and 64 MiB of decoded RGBA work per image or animation, with a 16,384-pixel maximum edge. Three downloads may run concurrently; each has a 10-second idle deadline and a 30-second total deadline. Animated images remain paused behind a generated static poster until the user explicitly plays them.

The Vercel Firewall must rate-limit `/api/push/subscriptions` and `/api/push/test` together to 60 requests per 600 seconds per IP. Do not include the Matrix callback in that IP rule; its application-level global budget is shared without storing homeserver or client identities. Stage the rule in log mode, inspect its matches, verify it on preview, and have the project owner publish it after review.
