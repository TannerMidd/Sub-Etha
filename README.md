# Sub-Etha

Sub-Etha is a fast, installable Matrix client with Rust-backed end-to-end encryption, IndexedDB persistence, virtualized timelines, authenticated media, and a privacy-minimal Web Push gateway.

Matrix access tokens, encryption keys, message bodies, sender names, room names, and synced history remain between the browser and the selected Matrix homeserver. The deployment backend stores only hashed opaque push keys, Web Push subscription material, timestamps, and seven-day delivery-deduplication records.

## Local development

Requirements: Node.js 22.13 or later.

```bash
npm ci
npm run dev
```

The local URL is printed by Vite. Matrix OAuth requires the deployed HTTPS origin; password, legacy SSO, and access-token login remain available locally when supported by the homeserver.

## Verification

```bash
npm run typecheck
npm run lint
npm run test:unit
npm run build
```

Generate D1 migrations after changing `db/schema.ts`:

```bash
npm run db:generate
```

## Hosted configuration

The Sites deployment uses the `DB` D1 binding declared in `.openai/hosting.json`. Configure these hosted secrets before enabling closed-app notifications:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT` (for example `mailto:admin@example.org`)

The gateway endpoints are:

- `GET /api/push/vapid-key`
- `POST /api/push/subscriptions`
- `DELETE /api/push/subscriptions`
- `POST /_matrix/push/v1/notify`

The Matrix pusher uses `event_id_only`. Notifications are deliberately generic; opening Sub-Etha fetches and decrypts the event directly from the homeserver.
