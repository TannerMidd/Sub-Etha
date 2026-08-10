# ADR-0006: Preserve an explicit virtualized-timeline state model

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: timeline rendering, pagination, scroll restoration, and composer geometry

## Context

Matrix timelines update from live events, decryption, edits, reactions, redactions, receipts, and backward pagination. A chat viewport must follow new content only while the reader is attached to the end, preserve the visible anchor when history is prepended, and avoid jumps when existing items change height.

Rendering an unbounded room timeline is not viable, so Sub-Etha uses React Virtuoso. Its internal spacer and measurement geometry is implementation-owned and can be broken by seemingly harmless CSS.

## Decision

Use React Virtuoso for timeline windowing and keep Sub-Etha's scroll policy in an explicit finite-state model with `initializing`, `attached`, `detached`, and `restoring-history` modes. Classify timeline changes independently from rendering and calculate prepend start-index offsets through pure helpers.

The timeline owns bottom attachment, pagination anchors, unread transitions, and compensation for asynchronous row-height changes. The composer and navigation may affect available viewport space, but they must not change Virtuoso's internal geometry.

### Required invariants

- Initial entry settles at the intended latest or unread anchor.
- Appends follow only when the reader is attached or the action explicitly requests it.
- Prepending history preserves the first visible content anchor.
- Edits, reactions, decryption, and media sizing do not force a detached reader to the bottom.
- The final message row remains visible above the composer.
- History controls remain reachable during restore operations.
- Mobile message actions and swipe navigation do not steal one another's gestures.
- CSS never targets Virtuoso's internal spacer elements.

## Consequences

### Positive

- Scroll behavior is modeled as state transitions instead of scattered timing flags.
- Pure classification and offset helpers are unit-testable.
- Large rooms remain responsive without sacrificing history position.

### Costs and trade-offs

- Virtualized timelines require careful identity and height management.
- Browser tests must cover asynchronous content and both supported viewport classes.
- Changes to Virtuoso versions need geometry-specific regression testing.

## Alternatives considered

### Render every event

This simplifies geometry but has unbounded memory and DOM cost for active rooms.

### Always scroll after any update

This is predictable for code but hostile to users reading history and incorrect for edits or decryption.

### Let the virtualization library own all policy

Virtuoso supplies mechanics, but Matrix-specific attachment and change semantics still require an application model.

## Enforcement and verification

- State machine: `lib/timeline-scroll.ts`
- Prepend geometry: `lib/timeline-window.ts`
- Integration: `app/components/Timeline.tsx`
- Layout owners: `app/styles/Timeline.module.scss`, composer styles
- Unit and CSS-invariant tests: `tests/*.test.ts`
- Desktop and mobile behavior: `tests/browser/`

## Revisit when

- The virtualization library no longer supports stable prepend anchoring.
- Product requirements add threaded or multi-axis timelines that cannot fit this state model.
- Browser-native content virtualization becomes mature enough to replace the library.

## Related decisions

- [ADR-0003](./0003-matrix-client-boundary.md)
- [ADR-0005](./0005-scss-modules-and-semantic-tokens.md)
- [ADR-0011](./0011-quality-gates.md)
