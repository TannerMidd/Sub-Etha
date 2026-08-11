# ADR-0011: Require layered local quality gates and fixed visual viewports

- Status: Deprecated
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: formatting, static analysis, tests, builds, accessibility, and visual regression

## Context

Sub-Etha's highest-risk regressions cross layers: an SDK event changes normalized state, asynchronous content changes virtualized geometry, a styling edit obscures an action on mobile, or server code builds locally but fails in production output. No single test type can cover those risks.

The compact layout is intentionally tuned for 1920×1080 desktop and 390×844 mobile reference viewports, while still using responsive rules between them.

## Decision

Treat `npm run check` as the complete local release gate. It runs Prettier verification, ESLint, strict TypeScript, Node unit tests, a production build, and the full Playwright suite. Keep unit tests for pure policy and boundary cases; browser tests for integrated user behavior, accessibility-facing hooks, service-worker behavior, and geometry; and visual snapshots for intentional design surfaces.

Run Playwright serially with one worker across desktop 1920×1080 and mobile 390×844 projects. Use roles, labels, IDs, and stable data attributes instead of CSS module hashes. Keep the visual-diff threshold at or below the configured 0.5 percent pixel ratio unless a superseding decision explains the change.

### Required invariants

- Formatting, lint, typecheck, unit tests, production build, and browser tests all pass before release.
- Tests do not select generated CSS module class names.
- Timeline geometry, history restoration, composer autosizing, and mobile message actions retain dedicated regression coverage.
- Visual baseline changes are reviewed as product changes, not automatically accepted noise.
- Console errors fail or are explicitly asserted in relevant browser flows.
- Intentional environment-dependent skips state their prerequisite.
- Accessibility lint rules and keyboard-focus behavior remain enabled.

## Consequences

### Positive

- Fast pure tests and high-fidelity browser tests cover different failure classes.
- Production compilation is validated independently from the dev server.
- Fixed reference viewports make density and visual regressions reproducible.
- Stable selectors allow styling implementation to change safely.

### Costs and trade-offs

- The complete gate takes longer than unit tests alone.
- Serial browser tests limit speed but reduce shared-state and screenshot variance.
- Snapshot updates require human visual review.
- Reference viewports do not replace exploratory testing across intermediate sizes.

## Alternatives considered

### Browser tests only

They are slower and less precise for policy boundaries, malformed inputs, and state-machine transitions.

### Unit tests and typecheck only

They cannot verify service-worker lifecycle, real layout, focus, touch gestures, virtualization, or compiled route behavior.

### Class-based browser selectors

They are convenient but couple behavior tests to private styling output and undermine SCSS module encapsulation.

## Enforcement and verification

- Commands and ordering: `package.json`
- Static rules: `eslint.config.mjs`, `tsconfig.json`
- Browser matrix and threshold: `playwright.config.ts`
- Unit tests: `tests/*.test.ts`
- Integrated tests and baselines: `tests/browser/`
- Complete command: `npm run check`

## Revisit when

- CI parallelization can preserve deterministic shared-state and screenshots.
- Supported devices require additional canonical viewport or browser projects.
- Test duration becomes a measured delivery bottleneck and an equivalent risk-based split is proposed.

## Related decisions

- [ADR-0005](./0005-scss-modules-and-semantic-tokens.md)
- [ADR-0006](./0006-virtualized-timeline.md)
- [ADR-0012](./0012-dependency-governance.md)
