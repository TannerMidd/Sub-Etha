# ADR-0023: Support a fully local Docker deployment topology

Status: Accepted
Date: 2026-08-22

## Context

Sub-Etha's production topology is Vercel plus Neon PostgreSQL (ADR-0016). The
server persistence layer reaches Neon through the Neon HTTP driver, which
speaks an HTTP protocol that a vanilla PostgreSQL server cannot answer, so the
application could only run against Neon. That made "clone and run the whole
system locally" impossible without cloud accounts, and it blocked newcomers,
demos, integration tests, and self-hosting.

The persistence boundary already isolates provider details behind
`db/index.ts` and the `PushRepository` contract, so adding a second PostgreSQL
transport is a contained change.

## Decision

Support a fully local, single-command Docker Compose deployment alongside the
unchanged production topology:

- `db/index.ts` selects the Drizzle adapter per connection string: hosts under
  `.neon.tech` use the Neon HTTP driver; every other host uses the standard
  PostgreSQL wire-protocol driver (`pg`). `DATABASE_DRIVER=neon|postgres`
  overrides detection. The shared database type remains the existing Neon HTTP
  surface so repository code keeps its current guarantees, including the
  absence of transactions.
- A committed multi-stage `Dockerfile` builds the existing Nitro output into a
  small non-root runtime image; no application behavior changes.
- A committed `docker-compose.yml` starts the app and PostgreSQL 17 with named
  volumes for data and generated VAPID keys, applies migrations through a
  programmatic runner (`scripts/migrate.mjs`) that shares drizzle-kit's
  history table, and auto-provisions Web Push keys on first start.
- Production deployment stays Vercel + Neon; this decision adds a supported
  local/self-hosted topology, it does not replace ADR-0016.

## Consequences

- One command (`docker compose up --build -d`) yields a complete local
  instance at `http://localhost:3000`; Matrix OAuth still requires the deployed
  HTTPS origin, matching the existing boundary.
- The wire-protocol driver must keep behavioral parity for every repository
  operation (atomic function calls, returning clauses, budgets). The
  integration suite runs unchanged against either transport when
  `DATABASE_URL` points at it.
- Two transports now need dependency governance: `pg` joins the lockfile and
  both drivers upgrade together with drizzle-orm.
- Migration compatibility rules are unchanged; the container migrates before
  serving on every start.
- The image contains no secrets: compose credentials protect an
  internal-network-only database, and VAPID keys live in a volume.

## Revisit when

- Self-hosted operation needs features the HTTP-driver contract forbids, such
  as transactions or batching, requiring a shared contract redesign.
- Local deployments need horizontal scaling beyond one node, TLS termination,
  or secrets management in scope.
- Production moves away from Vercel/Neon, superseding ADR-0016 directly.

## Related decisions

- [ADR-0016](./0016-runtime-and-deployment-topology.md)
- [ADR-0019](./0019-privacy-minimal-push-and-pwa.md)
- [ADR-0020](./0020-security-and-data-minimization.md)
