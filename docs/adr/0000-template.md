# ADR-NNNN: Decision title

- Status: Proposed
- Date: YYYY-MM-DD
- Owners: Sub-Etha maintainers
- Decision scope: concise list of affected boundaries

## Context

What problem must be solved? Include the forces that make the decision architectural: privacy, security, performance, compatibility, operability, maintainability, or reversibility. Describe the current state without assuming the reader has the implementation open.

## Decision

State the chosen direction in active language. Define the boundary, its public contract, and which layer owns each relevant state transition.

### Required invariants

- List rules that future implementations must preserve.
- Prefer outcomes that can be linked to code or tests.
- Include size, time, concurrency, retention, and compatibility limits when applicable.

## Consequences

### Positive

- What becomes simpler, safer, faster, or more predictable?

### Costs and trade-offs

- What complexity, coupling, operational work, or migration cost is accepted?

## Alternatives considered

### Alternative name

Explain why it was plausible and why it was not selected under the current constraints.

## Enforcement and verification

- Code or configuration anchors: `path/to/file`
- Automated checks: `test or command`
- Review-only checks: condition reviewers must confirm

## Revisit when

- State measurable triggers that would invalidate the assumptions behind this decision.

## Related decisions

- ADR-NNNN — relationship to this decision
