# Sub-Etha Zen Chat Design QA

## Build under review

- Branch: `QA`
- Deterministic chat route: `/?design-preview#/room/signal-watch`
- Deterministic login route: `/?design-preview&surface-preview=login`
- Source of truth: `designs/zen-chat-target-desktop.png` (1672 × 941)
- Final source-sized implementation: `designs/zen-chat-implementation-desktop-1672x941.png`
- Final large-desktop implementation: `designs/zen-chat-implementation-desktop-1920x1080.png`
- Final mobile conversation: `designs/zen-chat-implementation-mobile-conversation-390x844.png`
- Final mobile room index: `designs/zen-chat-implementation-mobile-rooms-390x844.png`
- Login captures: `designs/zen-login-desktop-1920x1080.png` and `designs/zen-login-mobile-390x844.png`
- Settings capture: `designs/zen-settings-desktop-1920x1080.png`
- Final side-by-side comparison, source then implementation: `designs/design-qa-zen-desktop-comparison.png`

All browser captures were made in the Codex in-app browser at device-pixel ratio 1. The desktop comparison uses the same 1672 × 941 viewport and the same Signal Watch fixture as the selected source. The mobile implementation is a responsive derivation because no separate mobile source image was selected.

## Visual-system result

- One Sass/CSS-module stack is retained throughout; no second styling technology was introduced.
- Inter is the only interface type family.
- The dark palette is warm graphite and ash with terracotta, steel blue, and sand accents. Purple and green are absent from the interface palette.
- Cards, bubbles, glow, gradients, and drop shadows were removed. Structure comes from one-pixel rules, short author strokes, whitespace, and typography.
- Dark and supported light themes use semantic tokens. Small accent text and participant labels meet normal-text contrast targets in both themes.
- The left rail, 105px desktop header, timestamp gutter, 48rem divider span, 22rem message rules, and bottom composer align to the selected desktop geometry.
- Own messages remain in transcript flow and use the visible label `You`; ARIA labels retain the real sender identity.
- Participant accents are stable by Matrix localpart and use five non-purple, non-green semantic colors.

## Responsive and PWA result

- Desktop: verified at 1672 × 941 and 1920 × 1080 with no horizontal document overflow.
- Mobile: verified at 390 × 844 with a full-screen room index, full-screen conversation, compact header, safe-area padding, and no horizontal document overflow.
- Opening the mobile room index moves focus to room search and makes the covered conversation inert and `aria-hidden`; closing returns focus to the index button.
- Mobile message actions expose Reply, Reaction, Edit, and Remove as 44 × 44 controls without extending the document width.
- Standalone PWA zoom remains available; no `user-scalable=no`, keyboard-zoom block, or wheel-zoom block remains.
- The service-worker shell cache was advanced to `sub-etha-shell-v6` so installed PWAs receive the new manifest and assets.
- The 192px, 512px, Apple touch, favicon, and Open Graph assets now use the graphite/terracotta/steel Zen mark. The generated master is `designs/zen-pwa-icon-master.png`.

## Comparison history

1. Initial integrated capture exposed a short desktop header, oversized message/divider rules, stale guide-era room/profile treatments, ambiguous unread dots, and an incorrectly marked Sol message.
2. The source-sized pass corrected author ownership and colors, numeric unread states, date/copy fixtures, rail/profile geometry, header height, flat row selection, and outgoing-message placement.
3. The fit pass reduced separator/reaction height so the full source conversation remained visible, aligned the date and unread rules to the 48rem source span, and matched the composer and timestamp gutters.
4. The final combined comparison confirmed the same viewport, content state, rail boundary, message geometry, whitespace, palette, and composer placement with no blocking visible difference.

## Findings and resolutions

1. [P1 fixed] Standalone mode disabled pinch, keyboard, and wheel zoom. Zoom blocking was removed while retaining `viewport-fit=cover`.
2. [P1 fixed] Dark signal text and light-theme author accents failed normal-text contrast. Theme-specific signal and participant tokens now clear the contrast threshold.
3. [P1 fixed] Existing PWAs could keep the old cache-first manifest. The shell cache version was bumped and all install assets were replaced.
4. [P2 fixed] The mobile room index exposed focusable content behind its full-screen surface. The conversation is now inert/hidden while open, with deterministic focus transfer in both directions.
5. [P2 fixed] Preview ownership, date, unread counts, and sender hashing did not reproduce the selected conversation. Fixtures and deterministic accent assignment now match the source state.
6. [P2 fixed] The first message/date could clip when the full conversation was bottom-aligned. Timeline density and divider geometry now keep all nine desktop messages visible.
7. [P2 fixed] Old green install and preview identity art conflicted with the no-green direction. PWA, social, favicon, and preview identity assets now use the new Zen mark.
8. [P3] User-generated reaction glyphs remain native reaction content instead of being replaced with decorative source-only icons. Their containers are flat and line-free, and interaction semantics are preserved.
9. [P3] The selected raster and the local Inter render have minor platform antialiasing differences only.

No actionable P0, P1, or P2 visual, responsive, accessibility, or interaction differences remain.

## Interaction and runtime verification

- Room-index open/close, focus transfer, inert state, and scroll containment: passed.
- Composer fill/send and local appended-message reveal: passed.
- Mobile action tray reachability and 44px control sizing: passed.
- Room details dialog, settings dialog, login surface, and theme controls: passed.
- Desktop and mobile console warnings/errors during verified routes: none.
- TypeScript: passed.
- ESLint: passed.
- Prettier check: passed.
- Unit suite: 95 passed, 3 intentional integration skips, 0 failed.
- Production build: passed; only existing bundle-size and ineffective-dynamic-import warnings were emitted.
- Visual baselines were replaced for desktop-1920 and mobile-390 chat/login plus desktop settings. Browser behavior and visuals were verified in the selected Codex in-app browser rather than a separate Playwright CLI run.

final result: passed
