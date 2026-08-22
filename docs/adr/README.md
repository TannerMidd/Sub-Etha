# Architecture Decision Records

ADRs preserve the rationale for decisions that define a durable system boundary. The current system is described in the [architecture map](../architecture.md); development workflow and ordinary codebase rules live in [code conventions](../code-conventions.md).

## When an ADR is warranted

Create an ADR only when a decision:

- has a credible alternative;
- changes a cross-cutting trust, data, ownership, runtime, persistence, or deployment boundary;
- is expensive or risky to reverse; and
- needs rationale that code, tests, or configuration cannot preserve clearly.

A security or privacy boundary qualifies even when the implementation is small. Package versions, numeric limits, viewports, selectors, commands, file paths, helper structure, and feature-level test cases do not need ADRs unless changing them alters one of the boundaries above.

## Status and process

Use **Proposed**, **Accepted**, **Deprecated**, **Superseded** with one or more replacement ADRs, or **Rejected**. Start from [`0000-template.md`](./0000-template.md), use the next number that has never appeared in repository history, and update this index. Accepted records are append-only; replace a changed decision with a new record and mark the old one superseded.

## Active decisions

| ADR                                                         | Decision                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| [0016](./0016-runtime-and-deployment-topology.md)           | Keep one browser application and a narrow push backend                     |
| [0017](./0017-browser-owned-matrix-boundary.md)             | Keep Matrix state and behavior browser-owned                               |
| [0018](./0018-timeline-position-and-windowing.md)           | Bound timeline rendering without moving the reader                         |
| [0019](./0019-privacy-minimal-push-and-pwa.md)              | Keep push privacy-minimal; its PWA caching scope is superseded by ADR-0021 |
| [0020](./0020-security-and-data-minimization.md)            | Minimize data and bound untrusted work                                     |
| [0021](./0021-cache-free-pwa-and-inert-offline-response.md) | Keep the worker cache-free with an inert offline response                  |
| [0022](./0022-browser-only-youtube-thumbnails.md)           | Keep bounded YouTube thumbnails browser-direct and privacy-minimal         |
| [0023](./0023-local-docker-deployment-topology.md)          | Support a fully local Docker deployment topology                           |

## Historical records

These records preserve earlier rationale but are not active constraints.

| ADR                                                 | Former decision                                                      | Status                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [0001](./0001-use-architecture-decision-records.md) | Use architecture decision records                                    | Deprecated; this README now governs the lightweight process           |
| [0002](./0002-runtime-react-vinext-vite-nitro.md)   | Use React with Vinext, Vite, and Nitro                               | Superseded by ADR-0016                                                |
| [0003](./0003-matrix-client-boundary.md)            | Isolate Matrix SDK state behind a browser service                    | Superseded by ADR-0017                                                |
| [0004](./0004-client-storage-and-tab-ownership.md)  | Keep private session state client-side and enforce one active tab    | Superseded by ADR-0017                                                |
| [0005](./0005-scss-modules-and-semantic-tokens.md)  | Use SCSS modules and semantic theme tokens                           | Deprecated; current guidance is in code conventions                   |
| [0006](./0006-virtualized-timeline.md)              | Preserve an explicit virtualized-timeline state model                | Superseded by ADR-0018                                                |
| [0007](./0007-media-security-and-caching.md)        | Bound, normalize, and cache Matrix media defensively                 | Superseded by ADR-0020                                                |
| [0008](./0008-privacy-minimal-web-push.md)          | Operate a privacy-minimal Web Push gateway                           | Superseded by ADR-0019                                                |
| [0009](./0009-neon-drizzle-persistence.md)          | Keep server persistence behind a Drizzle repository boundary         | Superseded by ADR-0016 and ADR-0019                                   |
| [0010](./0010-pwa-and-service-worker.md)            | Use a conservative app-shell service worker                          | Superseded by ADR-0019                                                |
| [0011](./0011-quality-gates.md)                     | Require layered local quality gates and fixed visual viewports       | Deprecated; current guidance is in code conventions                   |
| [0012](./0012-dependency-governance.md)             | Govern dependencies through npm, the lockfile, and explicit upgrades | Deprecated; current guidance is in code conventions                   |
| [0013](./0013-deployment-and-migrations.md)         | Deploy on Vercel and apply compatible migrations first               | Superseded by ADR-0016                                                |
| [0014](./0014-security-and-data-minimization.md)    | Treat privacy and bounded work as cross-cutting constraints          | Superseded by ADR-0020                                                |
| 0015                                                | Encrypt browser persistence and enforce a nonce CSP                  | Reserved; the decision was reverted and the number will not be reused |
