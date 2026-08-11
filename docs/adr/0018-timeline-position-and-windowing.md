# ADR-0018: Bound timeline rendering without moving the reader

- Status: Accepted
- Date: 2026-08-11
- Supersedes: ADR-0006

## Context

Matrix timelines can grow without a natural bound and can change after rendering because of pagination, edits, reactions, redactions, decryption, receipts, and media sizing. A reader who has moved into history must not be pulled away by those updates.

## Decision

Keep timeline DOM work bounded through windowing or virtualization while preserving these user-visible invariants:

- Initial entry settles at the latest content.
- New remote content follows only while the reader is attached to the end.
- Prepending history preserves the visible content anchor.
- Edits, decryption, reactions, and row-height changes do not move a detached reader to the end.
- A successful local message append reattaches to the end.

The virtualization library, state names, helper decomposition, correction timing, CSS structure, and gesture implementation are replaceable details. Tests should assert the behavior above rather than those mechanics.

## Consequences

- Large rooms remain usable without sacrificing reading position.
- Timeline changes require geometry-aware browser coverage in addition to pure policy tests.
- Replacing the windowing implementation is allowed if the observable invariants remain intact.

## Revisit when

- Product requirements introduce threaded or multi-axis timelines with different position semantics.
- Browser-native primitives can provide the same behavior with materially less application code.
