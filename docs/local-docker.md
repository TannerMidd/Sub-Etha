# Running Sub-Etha fully locally with Docker

This guide gets a complete Sub-Etha instance — application, local PostgreSQL database, applied migrations, and working Web Push keys — running on your machine with one command. Nothing outside Docker is required, and nothing reaches Vercel or Neon.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (Docker Desktop on Windows/macOS, or Docker Engine with the Compose plugin on Linux). Any machine that runs Linux/AMD64 or ARM64 containers works; every image used is multi-arch.

## Start

From the repository root:

```bash
docker compose up --build -d
```

The first start builds the application image (a few minutes), then:

1. starts PostgreSQL with a persistent data volume,
2. waits for it to accept connections,
3. applies all committed database migrations,
4. generates a Web Push (VAPID) key pair and stores it for future restarts,
5. serves the app at <http://localhost:3000>.

Watch progress with `docker compose logs -f app`. The instance is ready when the log shows "Applying database migrations" followed by the Nitro server banner.

Sign in with an existing Matrix account using password or access-token login. Matrix OAuth requires the deployed HTTPS origin and stays unavailable locally by design.

## What runs where

| Piece       | Container | Notes                                                                 |
| ----------- | --------- | --------------------------------------------------------------------- |
| Application | `app`     | The built Nitro server from this repository, port 3000 inside         |
| Database    | `db`      | PostgreSQL 17, not reachable from your host network unless you opt in |

State lives in two named volumes, so it survives restarts and rebuilds:

- `db-data` — push gateway database contents,
- `app-state` — generated VAPID keys (`vapid.json`).

## Everyday commands

```bash
docker compose logs -f app    # follow application logs
docker compose ps             # see container status
docker compose stop           # stop without deleting anything
docker compose start          # start again
docker compose down           # remove containers; volumes are kept
docker compose down -v        # full reset: containers AND data
```

A full reset and rebuild from scratch:

```bash
docker compose down -v
docker compose up --build -d
```

## Use Sub-Etha from your phone or another device

Two browser capabilities behave differently away from `localhost`, and knowing which is which saves time:

| Capability                                                                   | Needs                                           | Works on phone over plain HTTP LAN?        |
| ---------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| The chat app itself (login, rooms, messages, device verification while open) | Any reachable origin                            | Yes — browse to `http://<your-pc-ip>:3000` |
| Service worker, "Add to Home Screen", and **notifications** (Web Push)       | A secure context: HTTPS, or exactly `localhost` | **No**                                     |

Browsers only allow Web Push on secure origins. On your PC, `http://localhost:3000` qualifies; on a phone the same deployment is reached as `http://192.168.x.x:3000`, which is plain HTTP on a foreign host, so the browser never registers the service worker and notifications can never arrive there. This is enforced by every browser; no application setting can bypass it.

### Device verification prompts

"Verify with another device" travels through your Matrix homeserver as a live sync message, not through this deployment's push gateway. The prompt appears on the other device **only while that device's Sub-Etha tab or installed app is open and syncing at that moment**. If nothing pops up:

1. Open (or bring to the foreground) Sub-Etha on both devices.
2. Start the verification again from one of them.

A closed phone cannot be woken up for verification until notifications work on it, which needs the HTTPS setup below.

### Enable notifications on another device with the tunnel profile

The repository ships an optional Cloudflare quick tunnel that gives your local stack a public HTTPS URL with zero accounts:

```bash
docker compose --profile tunnel up -d tunnel
docker compose logs tunnel
```

Copy the `https://<something>.trycloudflare.com` URL from the logs and open it on your phone. Because that origin is HTTPS, the browser can install the PWA and register push. Then:

1. Sign in again on that origin (browser storage is per-origin).
2. Enable notifications in the app when prompted.
3. For homeserver-driven message notifications, also confirm your Matrix account's pusher points at the public URL — enabling notifications in the app sets this up automatically.

Notes and limits:

- Quick-tunnel URLs change whenever the `tunnel` container restarts. A new URL means a new origin: sign in and enable notifications again. For a stable name use [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) or a named Cloudflare tunnel pointed at `http://localhost:3000`.
- Set `VAPID_SUBJECT` to the origin you actually use before starting the `app` service if you care about the contact address embedded in push messages.
- Push subscriptions are per-origin: enabling notifications on the tunnel origin does not conflict with `localhost`; each browser manages its own subscription.
- A quick-tunnel URL is reachable from the public internet by anyone who learns it (long and unguessable, but not protected). Fine for testing; tear it down with `docker compose --profile tunnel down` when finished.

### Testing Matrix OAuth and SSO through the tunnel

The app refuses OAuth outside HTTPS by design — over `http://localhost:3000` it offers password, legacy SSO (homeserver permitting), and access-token login instead. The tunnel supplies a real HTTPS origin, which satisfies that requirement; the rest is homeserver policy:

1. Start the tunnel and open its `https://*.trycloudflare.com` URL.
2. Choose "Continue securely with OAuth". Sub-Etha registers itself dynamically with your homeserver's authentication service using `<tunnel-origin>/` as the redirect URI.

Whether login completes depends on what the homeserver accepts:

- Homeservers running [Matrix Authentication Service](https://github.com/matrix-org/matrix-authentication-service) **with dynamic client registration enabled** accept the new origin immediately. Self-hosting MAS? Set `dynamic_client_registration: true` while testing.
- Locked-down providers may reject unknown redirect URIs or clients. There is nothing to configure on this side; use password or access-token login there instead, or ask the administrator to allow your origin.
- Legacy SSO redirects must match the homeserver's allowlist (Synapse: `sso.allowed_client_redirect_url_patterns`). Synapse's defaults already cover `http://localhost` patterns, so SSO often works directly on `http://localhost:3000` without any tunnel; a tunnel hostname needs an admin-added pattern.

Because quick-tunnel URLs change on every restart, treat them as disposable test origins. For dependable OAuth, use a stable hostname (a named Cloudflare tunnel or Tailscale Funnel) so you allowlist exactly one origin with your homeserver once.

## Configuration

Everything has a working default; these overrides are optional.

### Different host port

If port 3000 is already used on your machine:

```bash
APP_PORT=8080 docker compose up --build -d
```

Then open <http://localhost:8080>. If you rely on Web Push in the browser, also set `VAPID_SUBJECT` to the origin browsers use, for example `-e` style via an environment line: add `VAPID_SUBJECT: http://localhost:8080` under `app.environment`, or export `VAPID_SUBJECT=...` before `docker compose up`.

### Bring your own VAPID keys

Generate once with any web-push tool (or reuse production keys if you own them):

```bash
npx web-push generate-vapid-keys
```

Then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` in the `app.environment` block of `docker-compose.yml` (or an override file). Environment-provided keys win over the auto-generated ones stored in `app-state`.

### Reach the database from your host

For debugging or running integration tests against the compose database, publish a port by adding to the `db` service (or an override file):

```yaml
ports:
    - "55432:5432"
```

The connection string is then `postgres://sub_etha:sub_etha@localhost:55432/sub_etha`.

### Custom state locations

Inside the `app` container, `/app/state` holds generated keys. Override with `SUB_ETHA_STATE_DIR` / `SUB_ETHA_VAPID_FILE` if you remap the volume.

## How the database driver is chosen

Production connects to Neon over its HTTP protocol; a local container speaks ordinary PostgreSQL wire protocol. The application picks per connection string automatically (`*.neon.tech` → Neon HTTP driver, anything else → standard driver), so the same image serves both. Set `DATABASE_DRIVER=neon|postgres` to force one explicitly. See [ADR-0023](./adr/0023-local-docker-deployment-topology.md).

Migrations run through `scripts/migrate.mjs`, which uses the same Drizzle migration history as `npm run db:migrate`; mixing container startups and developer machines against one database is safe.

## Troubleshooting

| Symptom                                                 | Cause and fix                                                                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Port already allocated error on `up`                    | Something else owns port 3000. Use `APP_PORT=<other>` as above.                                                       |
| App container restarts, logs show `wait-for-db` timeout | The database never became healthy. Check `docker compose logs db`; delete the `db-data` volume only if it is corrupt. |
| Logs show "VAPID key generation failed"                 | The `app-state` volume is not writable. Recreate it: `docker compose down && docker volume rm sub-etha_app-state`.    |
| Browser notifications do not arrive                     | Push needs a browser that supports Web Push and can reach the push provider; localhost HTTP works in Chrome/Firefox.  |
| Schema errors after switching between git branches      | Your branch changed migrations. Rebuild and let the entrypoint migrate: `docker compose up --build -d`.               |
| Want everything gone                                    | `docker compose down -v` removes containers, networks, and both volumes.                                              |

## Security notes

- Compose credentials (`sub_etha`/`sub_etha`) protect a database that is only reachable inside the compose network. Do not publish the DB port on untrusted networks.
- Generated VAPID private keys stay in the `app-state` volume on your machine.
- The container runs as the unprivileged `node` user.
