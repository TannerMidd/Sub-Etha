# Sub-Etha Zen Design QA

## Build under review

- Branch: `QA`
- Source of truth: `F:\Zen-like minimal flat design\Sub-Etha Zen.dc.html`
- Deterministic routes:
    - Conversation: `/?design-preview#/room/signal-watch`
    - Login: `/?design-preview&surface-preview=login`
    - Settings: `/?design-preview&surface-preview=settings#/room/signal-watch`
    - Mobile rooms: `/?design-preview&surface-preview=rooms`
    - Empty: `/?design-preview&surface-preview=empty`
    - Invite: `/?design-preview&surface-preview=invite#/room/observatory-invite`
- Side-by-side review board: `designs/zen-qa-comparison.html`
- Combined review capture: `designs/design-qa-zen-desktop-comparison.png`

The seven selected Zen frames are committed under `designs/` as `zen-target-*` captures. Matching implementation captures are stored as `zen-implementation-*`. Browser snapshots are the reproducible visual baselines.

## Visual-system result

- Commissioner is the interface family and Literata is the editorial message family. Both are self-hosted under `public/fonts/` with their OFL licenses.
- The application now uses the warm Zen plane (`#191614`), ink (`#eae5dd`), dividers (`#2a2624`), strong surfaces (`#38322e`), muted text, and gold accent (`#c9a86a`). Existing semantic token names and light/system theme support remain intact.
- Desktop chat matches the 340 px room rail, 96 px headers, 56 px conversation inset, continuous timeline axis, 680 px reading measure, and minimal text composer.
- Login matches the 1300/620 split, exact introductory copy and principles, quiet sign-in form, and outlined gold action while preserving password, OAuth, SSO, token, discovery, and error states.
- Settings matches the 1040 × 900 single-column row sheet. Profile, theme, push, recovery, device, test, and logout functions remain available through row actions and their deeper flows.
- Empty and invite states use the exact centered quiet treatments without the previous ornamental cards or icons.
- Icons, bubbles, gradients, glow, and drop shadows are absent from the selected surfaces. Structure comes from one-pixel rules, whitespace, typography, and accessible text controls.

## Responsive and interaction result

- Desktop conversation and login: verified at 1920 × 1080.
- Mobile conversation and room index: verified at 390 × 844.
- Empty and invite panels: verified at 762 × 406 outer dimensions, matching the source's 760 × 404 content plus one-pixel border.
- Settings sheet: verified at 1042 × 902 outer dimensions, matching the source's 1040 × 900 content plus one-pixel border.
- Mobile room navigation still transfers focus, hides and inerts covered conversation content, preserves history and swipe behavior, and contains scrolling.
- Message Reply, Reaction, Edit, and Remove remain reachable as 44 px mobile targets. Media, lightbox, retry, decryption, read receipts, draft persistence, paste/drop/upload, typing, autosize, reply/edit, Enter/Shift+Enter, and send behavior remain intact.
- Timeline virtualization keeps the bounded DOM, stable prepend anchor, detached-reader position, local-send reattachment, and late-media settling contracts.
- The service-worker cache is advanced to `sub-etha-shell-v7` and caches the new self-hosted font assets. Manifest theme and background colors use the Zen plane.

## Comparison history

1. The initial implementation pass established the new palette, typography, desktop shell, responsive navigation, settings sheet, and exact screen copy.
2. Visual comparison corrected mobile room/footer geometry, reply metadata, composer labels, settings row density, and the empty/invite crops.
3. Timeline regression testing exposed inaccurate initial estimates for offscreen media. Text-aware estimates and an attached-layout revision reduced the late-media shift to the expected tolerance without styling Virtuoso spacers.
4. Final captures were regenerated after fonts loaded and compared at every source viewport on one review board.

## Findings and resolutions

1. [P1 fixed] The old slate/coral/Inter system remained throughout the product despite the new Zen canvas. Global tokens, typefaces, manifest colors, and every specified surface now use the new system.
2. [P1 fixed] Initial virtual-row estimates no longer matched the wider vertical rhythm and could lurch when media dimensions resolved. Estimates now account for reading width, prose line count, and media height; attached-layout revisions rebuild only when required.
3. [P2 fixed] Mobile rooms previously retained tabs, a stacked footer, and a search-embedded new-room action. The frame now uses Brand/New, a 56 px search field, 80 px rows, and the horizontal identity/settings footer while keeping filtering available to assistive technology.
4. [P2 fixed] The mobile reply fixture lacked its referenced event after responsive fixture pruning. A normalized optional reply summary makes the target excerpt deterministic and gives production a graceful fallback when history is unavailable.
5. [P2 fixed] Settings originally exposed a two-column control dashboard. The Zen row sheet now fronts the same actions with compact summaries and preserves each deeper control flow.
6. [P3] Platform font rasterization can vary slightly from the static HTML canvas; geometry, family, weight, color, copy, and wrapping are aligned.

No actionable P0, P1, or P2 visual, responsive, accessibility, or interaction differences remain.

## Verification

- Visual snapshots: conversation desktop/mobile, login desktop/mobile, settings desktop, mobile rooms, empty, and invite.
- Browser runtime checks capture console warnings, console errors, and uncaught page errors on every visual route.
- Mobile navigation, composer geometry, timeline anchoring, pagination, async row changes, media sizing, and local-send regressions are covered by Playwright.
- TypeScript, ESLint, Prettier, unit tests, production build, and the full browser suite are required by `npm run check`.

final result: passed
