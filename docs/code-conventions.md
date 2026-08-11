# Codebase conventions

These rules keep routine changes consistent. They are deliberately not ADRs: the implementation may evolve without creating architectural history as long as the boundaries in [`architecture.md`](./architecture.md) remain intact.

## Toolchain and dependencies

- Use the Node.js version floor declared in `package.json` and npm with the committed `package-lock.json`.
- Use `npm ci` for a clean install. Change the lockfile through npm and review it with `package.json`.
- Treat framework, Matrix crypto, persistence, and prerelease upgrades as focused changes and run the relevant full checks. Exact pinning strategy is normal maintenance, not architecture.
- Remove unused dependencies and their obsolete configuration rather than retaining dormant alternatives.

## Validation

- `npm run check` is the local release gate. Its scripts and tool configuration define the exact checks, browsers, viewports, workers, and thresholds.
- During development, run the smallest relevant checks first, then the complete gate before release.
- Browser tests select accessible roles, labels, IDs, or intentional data attributes, never generated CSS-module names.
- Visual baseline changes are reviewed as product changes rather than accepted as test noise.

## UI and styles

- New component presentation belongs in a component-owned SCSS module. Global styles are reserved for document foundations, shared utilities, semantic theme variables, accessibility primitives, and cross-component or third-party selectors that cannot be owned by one module.
- Use semantic theme tokens instead of coupling components to palette literals.
- Generated class names are presentation details, not behavior or test contracts.
- Interaction states and reduced-motion behavior remain accessible, but exact geometry and palette choices belong to the implementation and design review.

## Database changes

- Change `db/schema.ts`, generate and review the corresponding Drizzle migration, and commit both.
- Follow the expand-and-contract rollout in [ADR-0016](./adr/0016-runtime-and-deployment-topology.md): apply compatible additions before dependent code and defer destructive removal.
- Include an apply-before-deploy plan when application code depends on new schema.

## Documentation

- Update `architecture.md` when a responsibility, state owner, or data flow changes.
- Write an ADR only when the [ADR admission rule](./adr/README.md#when-an-adr-is-warranted) is met.
- Put explanations beside the narrowest durable owner: architecture rationale in ADRs, current topology in the architecture map, workflow here, and implementation behavior in code or tests.
