# ADR-0007: Bound, normalize, and cache Matrix media defensively

- Status: Superseded by ADR-0020
- Date: 2026-08-10
- Owners: Sub-Etha maintainers
- Decision scope: Matrix downloads, uploads, previews, memory, and image safety

## Context

Matrix media is remote, may require authentication, may be encrypted, and cannot be trusted based on filename or declared metadata. Large or malformed files can consume bandwidth, memory, decoding work, and UI time. Animated images also create ongoing CPU and attention cost.

The client needs useful previews without proxying private media through the Sub-Etha backend.

## Decision

Fetch Matrix media directly from the browser with Matrix authorization and use the legacy media path only for explicitly classified compatibility responses. Bound transfer size, decoded image work, dimensions, concurrency, idle time, and total time. Inspect bytes and normalize uploads before treating media as an image.

Use a bounded LRU/object-URL cache. Generate a static poster for animated GIF content and require explicit user action to play animation. Revoke object URLs when evicted or when the service is disposed.

### Required invariants

- Automatic transfer size is capped at 64 MiB.
- Decoded RGBA work is capped at 64 MiB and image edges at 16,384 pixels.
- At most three media downloads run concurrently.
- Downloads have a 10-second idle deadline and a 30-second total deadline.
- Declared MIME type or extension alone never establishes image safety.
- Encrypted attachments are decrypted only in the browser.
- Authenticated media is not routed through the Sub-Etha backend.
- Cache eviction releases object URLs and does not retain unbounded bytes.
- Animated images are paused behind a static poster by default.

## Consequences

### Positive

- Malformed or oversized media has bounded resource impact.
- Private media stays between the browser and homeserver.
- Repeated previews avoid unnecessary network and decode work.
- Default-paused animation reduces ambient resource use.

### Costs and trade-offs

- Some legitimate very large media cannot be previewed automatically.
- Byte inspection and poster generation add client complexity.
- Browser format support can vary and requires graceful fallback.

## Alternatives considered

### Trust homeserver metadata

Homeserver metadata is useful but does not eliminate malformed content or decompression risk.

### Proxy and transform media on the backend

This would expose private authenticated media to Sub-Etha infrastructure and materially expand storage and security scope.

### Cache without hard limits

It improves short-term reuse but permits memory growth controlled by remote content and room activity.

## Enforcement and verification

- Limits and byte validation: `lib/matrix/media.ts`
- Fetching, decryption, queueing, and cache lifecycle: `lib/matrix/client.ts`
- Rendering and viewer behavior: `app/components/Timeline.tsx`
- Media unit tests: `tests/security-client.test.ts`, `tests/matrix-service.test.ts`

## Revisit when

- Product requirements need large-file streaming or background downloads.
- Matrix media APIs remove the authenticated or legacy compatibility split.
- Browser decoding APIs provide stronger isolated resource budgets.

## Related decisions

- [ADR-0003](./0003-matrix-client-boundary.md)
- [ADR-0014](./0014-security-and-data-minimization.md)
