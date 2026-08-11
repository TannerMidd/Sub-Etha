# Architecture Decision Records

Architecture Decision Records (ADRs) preserve the context and consequences of decisions that are expensive, cross-cutting, security-sensitive, or difficult to reverse. They complement the current [architecture map](../architecture.md).

## Status vocabulary

- **Proposed**: under review and not yet an implementation constraint.
- **Accepted**: the current architectural rule.
- **Deprecated**: retained for history but no longer recommended for new work.
- **Superseded by ADR-NNNN**: replaced by a newer decision; the original record remains intact.
- **Rejected**: evaluated and intentionally not selected.

## Decision index

| ADR                                                 | Decision                                                             | Status   |
| --------------------------------------------------- | -------------------------------------------------------------------- | -------- |
| [0001](./0001-use-architecture-decision-records.md) | Use architecture decision records                                    | Accepted |
| [0002](./0002-runtime-react-vinext-vite-nitro.md)   | Use React with Vinext, Vite, and Nitro                               | Accepted |
| [0003](./0003-matrix-client-boundary.md)            | Isolate Matrix SDK state behind a browser service                    | Accepted |
| [0004](./0004-client-storage-and-tab-ownership.md)  | Keep private session state client-side and enforce one active tab    | Accepted |
| [0005](./0005-scss-modules-and-semantic-tokens.md)  | Use SCSS modules and semantic theme tokens                           | Accepted |
| [0006](./0006-virtualized-timeline.md)              | Preserve an explicit virtualized-timeline state model                | Accepted |
| [0007](./0007-media-security-and-caching.md)        | Bound, normalize, and cache Matrix media defensively                 | Accepted |
| [0008](./0008-privacy-minimal-web-push.md)          | Operate a privacy-minimal Web Push gateway                           | Accepted |
| [0009](./0009-neon-drizzle-persistence.md)          | Keep server persistence behind a Drizzle repository boundary         | Accepted |
| [0010](./0010-pwa-and-service-worker.md)            | Use a conservative app-shell service worker                          | Accepted |
| [0011](./0011-quality-gates.md)                     | Require layered local quality gates and fixed visual viewports       | Accepted |
| [0012](./0012-dependency-governance.md)             | Govern dependencies through npm, the lockfile, and explicit upgrades | Accepted |
| [0013](./0013-deployment-and-migrations.md)         | Deploy on Vercel and apply compatible migrations first               | Accepted |
| [0014](./0014-security-and-data-minimization.md)    | Treat privacy and bounded work as cross-cutting constraints          | Accepted |

## Creating or changing a decision

1. Copy [`0000-template.md`](./0000-template.md) to the next unused four-digit number.
2. Describe the current problem and constraints before proposing a solution.
3. Record real alternatives and the reason they were not selected.
4. Name consequences, including operational cost and failure modes.
5. Add concrete enforcement anchors: code, tests, scripts, configuration, or review checks.
6. Open the ADR as **Proposed** when team review is needed; change it to **Accepted** only when the implementation and decision agree.
7. Add it to this index in the same change.

Accepted ADRs are historical records. Correct spelling or broken links in place, but do not silently rewrite a decision. When direction changes, add a new ADR, mark the old record **Superseded by ADR-NNNN**, and link both records.

## Review checklist

Architecture review should answer:

- Does the proposal have one clear state owner and a narrow public contract?
- Does data cross a new trust or persistence boundary?
- Is work bounded by size, time, concurrency, and retention where relevant?
- Can behavior be tested without depending on generated CSS names or SDK internals?
- Does the change preserve accessibility and the supported desktop and mobile geometry?
- Is rollout reversible, and are schema and deployment order requirements explicit?
- Which ADR is enforced, amended, or superseded?

## Enforcement map

| Concern                           | Primary enforcement                                      |
| --------------------------------- | -------------------------------------------------------- |
| Formatting and source consistency | Prettier, ESLint                                         |
| Type contracts                    | TypeScript strict mode                                   |
| Pure policy and security limits   | Node unit tests in `tests/*.test.ts`                     |
| Responsive UI and stable hooks    | Playwright in `tests/browser/`                           |
| Production integration            | `npm run build`                                          |
| Database evolution                | Drizzle schema and generated migrations                  |
| Architectural intent              | ADR review plus the boundaries in `docs/architecture.md` |
