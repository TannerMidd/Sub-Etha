# ADR-0016: Keep one browser application and a narrow push backend

- Status: Accepted
- Date: 2026-08-11
- Supersedes: ADR-0002, the platform portion of ADR-0009, and ADR-0013

## Context

Sub-Etha is a browser-owned Matrix client with a small server-side Web Push capability. A single deployment origin keeps application routing, OAuth callbacks, PWA scope, and push endpoints coherent. The database coordinates push subscriptions and delivery budgets across server instances.

Changing the runtime or deployment topology is expensive because it affects local development, route output, service-worker behavior, environment configuration, and database rollout. Routine package upgrades are not architectural decisions.

## Decision

Use React with Vinext, Vite, and Nitro for the application, deploy the combined application on Vercel, and use Neon PostgreSQL through Drizzle for push persistence.

Keep the backend narrow: it serves the application and operates the push gateway. Its supported contracts do not request, use, log, or persist Matrix authentication, sync, encryption, content, or media. Untrusted requests may contain unwanted fields, which remain bounded input and are ignored or rejected rather than becoming application data. Framework routes remain thin entry points; push validation and policy stay in testable modules rather than being duplicated across routes.

Evolve the database with expand-and-contract migrations. Apply backward-compatible schema changes before code that requires them, deploy and verify the application, and remove obsolete schema only after older application versions can no longer run.

The exact package versions, build commands, repository interfaces, and environment variable names remain implementation and operations concerns.

## Consequences

- One origin simplifies browser security boundaries and deployment ownership.
- The chosen prerelease runtime components require deliberate upgrade testing.
- Vercel and Neon remain operational dependencies until this decision is replaced.
- Destructive schema changes may require more than one release.

## Revisit when

- The browser application and push service need independent ownership, scaling, or deployment.
- The runtime cannot support a required stable platform feature.
- The push workload no longer fits request-oriented Vercel and Neon operation.

Current topology is mapped in [`../architecture.md`](../architecture.md). Deployment commands and release checks belong in [`../code-conventions.md`](../code-conventions.md).
