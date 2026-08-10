# Sub-Etha Night Edition Design QA

## Source and implementation evidence

- Supplied desktop source of truth: `designs/sub-etha-new-visual-target-desktop-1920x1080.png`
- Desktop implementation capture: `designs/sub-etha-night-edition-implementation-desktop-1920x1080.png`
- Desktop side-by-side comparison, reference then implementation: `designs/design-qa-night-edition-desktop-comparison.png`
- Mobile source of truth: `designs/sub-etha-night-edition-mobile-390x844.png`
- Mobile implementation capture: `designs/sub-etha-night-edition-implementation-mobile-390x844.png`
- Mobile side-by-side comparison, reference then implementation: `designs/design-qa-night-edition-mobile-comparison.png`
- Login captures: `designs/sub-etha-night-edition-login-desktop-1920x1080.png` and `designs/sub-etha-night-edition-login-mobile-390x844.png`
- Settings capture: `designs/sub-etha-night-edition-settings-desktop-1920x1080.png`
- Deterministic browser route: `/?design-preview#/room/signal-watch`

The implementation captures are Chromium PNG renders at device-pixel ratio 1. The tested state is the dark Signal Watch preview fixture with an empty, unfocused, one-line composer.

## Theme and architecture result

- Dark semantic tokens use canvas `#010709`, raised surface `#041113`, elevated surface `#071a1c`, primary text `#f0e4c7`, muted text `#91a8a1`, teal `#63d8bd`, signal red `#ff5645`, and guide amber `#e9b44c`.
- The light theme remains available through the same semantic token names. The existing `light | dark | system` preference is preserved, with dark as the no-preference fallback.
- Styling is compiled from Sass tokens and mixins, a minimal global foundation, shared primitives, and component-scoped Brand, Login, Shell, Timeline, Composer, and Panels modules.
- `sass` and `clsx` provide the styling toolchain and class composition. Tailwind and PostCSS are no longer part of the styling path.
- CSS module hashes remain private. Runtime behavior and browser coverage use roles, IDs, `data-ui`, `data-state`, `data-scroll-mode`, and `data-swipe-lock` hooks.
- The receiver illustration reuses `public/night-receiver-linework.png`; no replacement CSS ornament or synthetic asset was introduced.

## Measured desktop result

- Shell: 1920 × 1080.
- Grid: 350px room rail, 1152px conversation, and 418px Guide rail.
- Conversation header: 158px. The measured title glyph width is 266px, matching the supplied display scale.
- Timeline: y=158 through y=944, with the newest row retained above the composer and no visible browser scrollbar.
- Composer region: 73px, with the 56px field aligned at y=944 in the source composition.
- Receiver status: 63px, beginning at y=1017.
- Rail borders, guide dividers, note card, and receiver plate align to the supplied three-column geometry.

## Measured mobile result

- Shell: 390 × 844.
- Header: 84px with the inset guide-rule divider and 44px action targets.
- Timeline: y=84 through y=705.
- Mobile Guide Footnote: 61px, y=705 through y=766, using the receiver-linework asset.
- Composer: 45px, y=766 through y=811. The textarea remains autosizing and the action buttons remain 44px touch targets.
- Receiver status: 33px, y=811 through y=844, with the compact `Connected / End to end private / 7` treatment.
- The full Guide rail remains available on larger screens; mobile retains labelled Details access while presenting the source-matched footnote treatment.

## Interaction and behavior acceptance

- Timeline spacer geometry remains owned by Virtuoso.
- History pagination preserves its reading anchor, rejects concurrent requests, exposes retry, stops at exhaustion, and returns to the newest message on desktop and mobile.
- The final row remains clear of the composer while attached; detached reading positions survive asynchronous timeline updates.
- Collapsed mobile message actions no longer extend the virtual scroll height. The explicit open state reveals the complete 44px action menu.
- Composer coverage includes one, four, six, and eight lines, paste, resize, reply, edit cancellation, clear, and send.
- Mobile coverage verifies edge-swipe open and close, vertical-scroll priority, control and dialog exclusions, header Back, browser Back, and reduced motion.
- Visual captures cover desktop and mobile chat, desktop and mobile login, and desktop settings with zero runtime console warnings, console errors, or page errors.

## Visual findings and resolution

1. [P1 fixed] The first mobile action treatment remained visually hidden but still contributed overflow to Virtuoso. Collapsed actions now leave layout entirely, while `data-actions-state="open"` restores the full menu.
2. [P1 fixed] The decorative history label and third-party scrollbar override depended on generated module hashes during hot reload. They now use stable `data-ui` and role hooks in the minimal global override layer.
3. [P2 fixed] Desktop rails, the 158px header, title width, 63px receiver strip, right-side Guide card, and receiver illustration were rebuilt to the supplied 1920 × 1080 proportions.
4. [P2 fixed] Mobile now carries the 84px header, source-scaled title, Guide Footnote, 45px composer, compact private-status copy, and inset rules shown in the 390 × 844 target.
5. [P2 fixed] The deprecated compact color treatment was replaced with the requested semantic Night Edition palette and consistent red, teal, and amber roles.
6. [P3] Minor glyph-antialiasing differences remain between the supplied raster artwork and the locally bundled variable font render; line lengths, hierarchy, and wrapping are aligned.

No actionable P0, P1, or P2 visual differences remain.

## Verification

- Prettier write and `format:check`: passed.
- ESLint: passed.
- TypeScript typecheck: passed.
- Unit suite: 95 passed, 3 intentional integration skips, 0 failed.
- Production build: passed.
- Complete Playwright suite: 23 passed, 5 intentional project skips, 0 failed.
- Focused visual and runtime-console suite: 5 passed, 1 intentional mobile settings skip, 0 failed.
- Stable snapshots cover `desktop-1920` and `mobile-390`.

final result: passed
