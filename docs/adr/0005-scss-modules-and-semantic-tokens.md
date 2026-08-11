# ADR-0005: Use SCSS modules and semantic theme tokens

- Status: Deprecated
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: styling, theming, accessibility, and UI test contracts

## Context

Sub-Etha has a dense three-rail desktop interface and compact mobile navigation. A previous large global stylesheet made selector ownership unclear and allowed unrelated changes to collide. The Night Edition design also requires a shared semantic palette and consistent interaction states without turning visual class names into behavior contracts.

## Decision

Use Sass with shared tokens and mixins through `@use`, component-scoped `.module.scss` files, and a small global SCSS foundation for reset, fonts, document-level theme variables, accessibility, and unavoidable third-party overrides. Use `clsx` through the local style helper for conditional composition.

Support `light`, `dark`, and `system` preferences through the same semantic variables. When no preference exists, dark is the fallback. Use red for unread and primary signal actions, teal for identity, security, and status, and amber for guide references.

### Required invariants

- Every component selector has one owning module or intentional global owner.
- Generated CSS module names are private and never used as behavior or test selectors.
- Roles, IDs, `data-ui`, `data-state`, and `data-swipe-lock` provide stable behavior hooks.
- Global styles do not reintroduce component layout ownership.
- Focus-visible, hover, pressed, disabled, and reduced-motion states remain explicit.
- Supported touch controls retain a minimum 44-pixel target where space permits.
- Virtuoso internal spacers are not styled.
- Theme changes preserve semantic roles rather than remapping colors ad hoc.

## Consequences

### Positive

- Selector ownership is local and reviewable.
- Theme consistency comes from semantic tokens rather than repeated literals.
- Component restyling is less likely to change automation or application behavior.
- Shared Sass primitives preserve density while keeping interaction states consistent.

### Costs and trade-offs

- Cross-component visual changes may touch shared tokens and several modules.
- Global third-party overrides require careful documentation and stable upstream hooks.
- Sass compilation and CSS-module mappings add a build-time layer.

## Alternatives considered

### One global stylesheet

It is direct but previously produced overlapping selector ownership and made removal or refactoring risky.

### Tailwind utilities

The installed pipeline provided no meaningful utility styling, and utility-heavy markup would not improve the app's detailed field-guide visual language or selector ownership.

### CSS-in-JS

It could scope styles but adds runtime or framework coupling where static CSS modules are sufficient.

## Enforcement and verification

- Theme tokens and mixins: `app/styles/`
- Component ownership: `app/styles/*.module.scss`
- Class composition: `app/styles/appStyles.ts`
- CSS invariants and browser selectors: `tests/`
- Visual baselines: `tests/browser/*.spec.ts-snapshots/`
- Full validation: `npm run check`

## Revisit when

- A component library can express the Night Edition system without losing density, semantic theming, or private class names.
- CSS platform features eliminate the value of Sass while preserving shared tokens and mixins.

## Related decisions

- [ADR-0006](./0006-virtualized-timeline.md)
- [ADR-0011](./0011-quality-gates.md)
