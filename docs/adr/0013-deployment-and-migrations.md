# ADR-0013: Deploy on Vercel and apply compatible migrations first

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: hosting, environment configuration, route compatibility, and database rollout

## Context

Sub-Etha's web runtime, static assets, and push handlers need one HTTPS deployment origin. Matrix OAuth depends on a stable HTTPS callback origin, and Web Push requires service-worker scope and VAPID configuration. The push gateway uses Neon tables and database functions that application code may depend on immediately after deployment.

Serverless rollouts can briefly run old and new application versions against the same database, so destructive or incompatible schema changes create avoidable outage risk.

## Decision

Deploy the Vinext/Vite/Nitro output on Vercel and use Neon provisioned through the deployment environment. Keep the Matrix push callback rewrite in `vercel.json`. Treat production environment variables as deploy-time configuration and fail closed when required secrets are absent.

Use expand-and-contract schema evolution. Generate and review Drizzle migrations, apply backward-compatible database changes before application code that requires them, deploy the application, verify it, and remove obsolete schema only in a later release after old code can no longer run.

Keep Web Push disabled on preview deployments. Preview may verify UI and server compilation, but production-only push behavior requires controlled production configuration and smoke tests.

### Required invariants

- Production uses HTTPS and a stable OAuth callback origin.
- Required database and VAPID secrets are environment-provided and never committed.
- The Matrix push route remains reachable at `/_matrix/push/v1/notify`.
- Migrations are generated from the reviewed schema and committed.
- Database changes needed by new code are applied before that code is promoted.
- Destructive changes use a separate contract phase after compatibility is established.
- Preview deployments cannot register or deliver production push subscriptions.
- Rollout verification covers application startup, database access, and configured push endpoints.

## Consequences

### Positive

- One origin simplifies PWA scope, OAuth callbacks, and operational ownership.
- Compatible migration ordering reduces deployment races and rollback risk.
- Preview isolation protects real subscriptions and rate budgets.
- Vercel and Neon integrate with the request-oriented workload.

### Costs and trade-offs

- Production push paths cannot be fully exercised in ordinary previews.
- Some schema removals require two releases.
- Hosting and database-provider behavior remain operational dependencies.
- Environment drift must be checked explicitly.

## Alternatives considered

### Apply migrations during application startup

Concurrent serverless starts make this difficult to coordinate and couple availability to migration locks and permissions.

### Deploy code before schema

This creates a window where new application code calls missing tables, columns, or functions.

### Separate static hosting and push service

It can scale ownership independently but adds origins, configuration, and deployment coordination that current load does not justify.

## Enforcement and verification

- Build and rewrite: `vercel.json`, `vite.config.ts`
- Schema and migration config: `db/schema.ts`, `drizzle.config.ts`, `drizzle/`
- Commands: `npm run db:generate`, `npm run db:migrate`, `npm run build`
- Environment contract and production checklist: `README.md`
- Push preview guard: `lib/push-server.ts`

## Revisit when

- Hosting requirements exceed Vercel's runtime or service-worker routing model.
- Push delivery needs durable background queues or regional placement.
- The database provider or deployment platform changes.

## Related decisions

- [ADR-0002](./0002-runtime-react-vinext-vite-nitro.md)
- [ADR-0008](./0008-privacy-minimal-web-push.md)
- [ADR-0009](./0009-neon-drizzle-persistence.md)
