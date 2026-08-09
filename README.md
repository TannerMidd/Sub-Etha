# Sub-Etha

Sub-Etha is a fast, installable Matrix client with Rust-backed end-to-end encryption, IndexedDB persistence, virtualized timelines, authenticated media, and a privacy-minimal Web Push gateway hosted on Vercel.

Matrix access tokens, encryption keys, message bodies, sender names, room names, and synced history remain between the browser and the selected Matrix homeserver. The deployment backend stores only hashed opaque push keys, Web Push subscription material, timestamps, and seven-day delivery-deduplication records.

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

The gateway endpoints are:

- `GET /api/push/vapid-key`
- `POST /api/push/subscriptions`
- `DELETE /api/push/subscriptions`
- `POST /api/push/test`
- `POST /_matrix/push/v1/notify`

The Matrix pusher uses `event_id_only`. Notifications are deliberately generic; opening Sub-Etha fetches and decrypts the event directly from the homeserver. Push is intentionally unavailable on Vercel preview deployments.
