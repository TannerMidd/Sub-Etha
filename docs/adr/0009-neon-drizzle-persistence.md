# ADR-0009: Keep server persistence behind a Drizzle repository boundary

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: server data model, database access, migrations, and test seams

## Context

The push gateway needs durable subscription material, pending confirmation challenges, aggregate capacity and rate budgets, and short-lived delivery deduplication. It does not need Matrix account or message persistence. Database-specific operations must support atomic registration, budgets, cleanup, and leases without spreading SQL and Neon details through route handlers.

## Decision

Use Neon PostgreSQL through Drizzle ORM and the Neon HTTP driver. Define the server schema in `db/schema.ts`, obtain connections through `db/index.ts`, and keep push persistence behind the `PushRepository` contract. Route handlers call the push service; the service uses the repository and does not own transport concerns.

Schema changes are represented by generated, reviewed migrations in `drizzle/`. Database functions or transactional SQL may be used when an invariant cannot be safely expressed as independent ORM operations, but they remain repository implementation details.

### Required invariants

- Server tables contain only data categories permitted by the push and data-minimization ADRs.
- Capability lookup values are hashes, not plaintext secrets.
- Uniqueness and primary-key constraints enforce endpoint, capability, and delivery identity.
- Capacity and rate-budget updates are atomic under concurrency.
- Pending challenges and delivery records have bounded retention and cleanup paths.
- Application policy depends on `PushRepository`, not directly on Neon clients or table objects.
- Schema changes include a migration and compatible deployment order.

## Consequences

### Positive

- PostgreSQL constraints and atomic operations protect multi-instance server behavior.
- Drizzle keeps the schema and TypeScript model close together.
- The repository seam enables focused service tests and isolates provider details.
- Neon matches Vercel's request-oriented server runtime.

### Costs and trade-offs

- Some correctness-critical paths require careful SQL beyond basic ORM calls.
- Neon and Drizzle upgrades can affect driver and migration behavior.
- Repository interfaces must evolve when persistence semantics change.

## Alternatives considered

### Store push state in memory

This cannot coordinate Vercel instances and loses subscriptions on restart.

### Key-value storage

It suits simple capabilities but makes unique endpoints, compound delivery identity, atomic capacity, and cleanup queries less direct.

### Access Drizzle directly from routes

This reduces files but couples transport, policy, and persistence and makes security behavior harder to unit test.

## Enforcement and verification

- Schema: `db/schema.ts`
- Connection factory: `db/index.ts`
- Repository contract and implementation: `lib/push-repository.ts`
- Service boundary: `lib/push-server.ts`
- Migration configuration and history: `drizzle.config.ts`, `drizzle/`
- Generation and apply commands: `npm run db:generate`, `npm run db:migrate`

## Revisit when

- Persistence expands beyond the push gateway.
- Workload measurements show the HTTP driver or relational model is the limiting factor.
- Deployment moves away from Vercel and Neon.

## Related decisions

- [ADR-0008](./0008-privacy-minimal-web-push.md)
- [ADR-0013](./0013-deployment-and-migrations.md)
- [ADR-0014](./0014-security-and-data-minimization.md)
