# ADR-0012: Govern dependencies through npm, the lockfile, and explicit upgrades

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: package manager, runtime baseline, versioning, and upgrade review

## Context

Sub-Etha depends on security-sensitive and fast-moving packages: Matrix crypto and media handling, React, Vinext, Vite, Nitro, Drizzle, browser automation, and Sass. Uncoordinated upgrades can change runtime compatibility, route output, SDK semantics, virtualized geometry, generated CSS, or migration behavior.

The repository has an npm lockfile and requires Node.js 22.13 or newer. Some foundational packages are exactly pinned while compatible libraries use caret ranges resolved by the lockfile.

## Decision

Use npm and commit `package-lock.json` as the reproducible dependency graph. Use `npm ci` for clean environments. Keep the Node engine floor in `package.json` and upgrade it deliberately.

Exactly pin foundational packages when patch-level drift can alter framework integration, compiler output, React compatibility, or database migrations. Caret ranges are acceptable for libraries with stable compatibility contracts, but the lockfile remains authoritative for normal builds. Group coupled upgrades, especially React and RSC packages, Vinext/Vite/Nitro, Matrix SDK and crypto, and Drizzle ORM/Kit.

Remove unused packages and build plugins rather than retaining dormant stack options. Every dependency must have an identifiable runtime, build, test, or tooling owner.

### Required invariants

- `package-lock.json` changes only through npm and is reviewed with manifest changes.
- Clean installation uses `npm ci`, not an unlocked resolver.
- Runtime and toolchain upgrades pass the complete quality gate.
- Security-sensitive upgrades include review of release notes and affected boundaries.
- Coupled packages are upgraded and validated together.
- Prerelease packages are never advanced as incidental maintenance.
- A new dependency is justified against native platform and existing-library options.
- Removed integrations also remove obsolete configuration and tests.

## Consequences

### Positive

- Local, CI, and production installs resolve the same graph.
- Exact pins constrain high-risk integration surfaces.
- Explicit upgrade groups make regression diagnosis and rollback clearer.
- The stack remains smaller and easier to audit.

### Costs and trade-offs

- Maintainers must actively schedule upgrades instead of relying on ambient semver drift.
- Exact pins may delay bug fixes until reviewed.
- Lockfile conflicts require care during parallel dependency work.

## Alternatives considered

### Use only caret ranges

This lowers manifest maintenance but permits clean installs to resolve unreviewed foundational versions when the lockfile is regenerated.

### Pin every dependency exactly

This maximizes manifest precision but adds noise for stable leaf libraries while the lockfile already fixes the complete graph.

### Adopt another package manager

No current workspace or performance constraint justifies migration and lockfile churn.

## Enforcement and verification

- Runtime floor, versions, and scripts: `package.json`
- Resolved dependency graph: `package-lock.json`
- Clean install: `npm ci`
- Upgrade validation: `npm run check`
- Review must identify coupled packages and any ADR boundary affected.

## Revisit when

- npm cannot provide reproducible or operationally acceptable installs.
- The repository becomes a monorepo that needs workspace behavior beyond current npm support.
- Automated dependency updates can reliably group coupled packages and run the full gate.

## Related decisions

- [ADR-0002](./0002-runtime-react-vinext-vite-nitro.md)
- [ADR-0011](./0011-quality-gates.md)
- [ADR-0013](./0013-deployment-and-migrations.md)
