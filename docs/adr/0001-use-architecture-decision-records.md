# ADR-0001: Use architecture decision records

- Status: Accepted
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: architecture governance and technical documentation

## Context

Sub-Etha combines a Matrix client, end-to-end encryption, browser persistence, virtualized UI, a PWA service worker, and a server-side push gateway. Many safe-looking local changes can alter privacy, scroll behavior, deployment order, or recovery semantics. Code and tests show what exists but do not preserve why a boundary was chosen or which alternatives were rejected.

## Decision

Maintain numbered Markdown ADRs in `docs/adr`. Use them for decisions that are cross-cutting, security-sensitive, operationally significant, difficult to reverse, or likely to be questioned later. Keep `docs/architecture.md` as the current system map and the ADRs as the historical rationale.

### Required invariants

- ADR numbers are never reused.
- Accepted records are not rewritten to hide a later change.
- A changed direction creates a new ADR and marks the old one as superseded.
- Every ADR names consequences, alternatives, enforcement anchors, and revisit triggers.
- The ADR index is updated in the same change as a new record.
- Implementation and accepted decision must agree before a change is considered complete.

## Consequences

### Positive

- Maintainers can evaluate proposals against explicit boundaries rather than rediscovering context.
- Security and operational assumptions become reviewable.
- Supersession creates an auditable architectural history.

### Costs and trade-offs

- Cross-cutting changes require documentation work.
- An ADR can become misleading if enforcement anchors are not kept current.
- Small decisions still require judgment about whether an ADR is warranted.

## Alternatives considered

### Rely on code and pull-request history

This is low ceremony, but source does not record rejected alternatives and review history may be unavailable or hard to search.

### One mutable architecture document

A single document describes the present well but tends to erase the sequence and rationale of changed decisions.

## Enforcement and verification

- Process and index: `docs/adr/README.md`
- Current system map: `docs/architecture.md`
- Template: `docs/adr/0000-template.md`
- Review must identify any ADR affected by an architectural change.

## Revisit when

- The project adopts a documentation system that preserves immutable decisions and bidirectional links with equivalent clarity.

## Related decisions

- This is the governing record for all later ADRs.
