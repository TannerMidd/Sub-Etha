# ADR-0022: Browser-only YouTube thumbnails

Status: Accepted

## Decision

Sub-Etha may render at most three bounded YouTube thumbnail cards from eligible
message or notice bodies. The browser parses a strict, lowercase HTTPS allowlist
of YouTube URL forms and constructs only the exact public thumbnail URL
`https://i.ytimg.com/vi/<id>/hqdefault.jpg` and canonical watch URL
`https://www.youtube.com/watch?v=<id>`.

The thumbnail is a lazy browser-direct image. Sub-Etha does not proxy, fetch,
cache, persist, or unfurl YouTube URLs through its backend or Matrix services.
Failed thumbnail IDs are kept only in a bounded in-memory FIFO store so a
virtualized timeline cannot repeatedly request a known-bad image. A failed card
becomes inert and keeps its reserved geometry.

## Privacy boundary

The browser sends the public video ID and ordinary network metadata to the
YouTube CDN only when a lazy card enters the viewport. No Sub-Etha backend,
Matrix credential, room or user identity, or other message content is sent to
YouTube by this feature. New providers or general-purpose unfurling require a
separate security and privacy review.

## Consequences

- The content security policy allows only `https://i.ytimg.com` in `img-src`.
- Sanitized Matrix HTML remains unable to create images or image sources.
- URL parsing remains intentionally narrower than YouTube's full web URL surface.
- The feature depends on the browser and YouTube CDN being available; there is
  no server-side fallback or retry action.
