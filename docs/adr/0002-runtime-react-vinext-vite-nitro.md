# ADR-0002: Use React with Vinext, Vite, and Nitro

- Status: Superseded by ADR-0016
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: application runtime, build system, routing, and server handlers

## Context

Sub-Etha needs a rich client runtime for Matrix sync and encryption, file-based application and API routes, fast local development, a production server bundle, and Vercel-compatible deployment. The UI is fundamentally browser-owned, while a small number of server routes operate the push gateway.

The repository already uses React 19, a Next-compatible application shape, Vinext, Vite, and Nitro. Vinext and Nitro are prerelease dependencies, so the benefit of this stack comes with explicit upgrade risk.

## Decision

Use React as the UI runtime, Vinext as the Next-compatible application adapter, Vite as the development and production build system, and Nitro for server output. Keep the route and component structure compatible with the subset exercised by the application instead of depending broadly on undocumented Next.js behavior.

### Required invariants

- Browser-only Matrix and DOM code remains below a client boundary.
- Server route handlers remain thin adapters over testable service modules.
- `vite.config.ts` is the authoritative plugin composition for builds.
- `npm run build` must succeed before accepting runtime or routing changes.
- Framework-specific imports are kept at application edges when a plain TypeScript contract is sufficient.
- Prerelease runtime upgrades are intentional changes with browser and production-build verification.

## Consequences

### Positive

- React provides the required interactive client model and established accessibility patterns.
- Vite keeps development and builds fast.
- The Next-like route shape remains easy to navigate while Nitro supplies deployable server output.

### Costs and trade-offs

- Vinext and Nitro beta behavior may change and can lag or differ from Next.js.
- Some ecosystem documentation assumes an official Next.js runtime and must be validated locally.
- The stack has more integration seams than a client-only Vite application.

## Alternatives considered

### Official Next.js runtime

It offers the broadest compatibility with Next conventions, but the current Vinext/Vite path is established and meets the app's limited server needs. Migration cost is not justified without a concrete incompatibility.

### Client-only Vite SPA plus a separate API service

This simplifies the frontend build but introduces separate deployment, routing, and local-development lifecycles for a small backend.

### Another UI framework

A rewrite would add risk to Matrix, virtualization, accessibility, and PWA behavior without solving a current constraint.

## Enforcement and verification

- Runtime composition: `vite.config.ts`, `app/layout.tsx`, `app/page.tsx`
- Server routes: `app/api/`
- TypeScript client boundaries and production build: `npm run typecheck`, `npm run build`
- End-to-end runtime behavior: `npm run test:browser`

## Revisit when

- Vinext or Nitro cannot support a required stable platform feature.
- Prerelease churn repeatedly blocks upgrades or production builds.
- The backend grows enough to require independent scaling, ownership, or deployment.

## Related decisions

- [ADR-0003](./0003-matrix-client-boundary.md)
- [ADR-0012](./0012-dependency-governance.md)
- [ADR-0013](./0013-deployment-and-migrations.md)
