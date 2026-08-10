# Sub-Etha Night Receiver Console QA

## Reference and evidence

- Desktop reference: `designs/sub-etha-night-edition-desktop-1920x1080.png`
- Desktop implementation evidence: production-build capture at 1920 x 1080.
- Mobile reference: `designs/sub-etha-night-edition-mobile-390x844.png`
- Mobile implementation evidence: production-build capture at 390 x 844.
- Local preview route: `/?design-preview#/room/signal-watch`

The final screenshots were captured from the rebuilt production output on an uncached local origin at device-pixel ratio 1.

## Desktop comparison

- Viewport: exactly 1920 x 1080 CSS pixels.
- Geometry: 350px transmission index, 1152px conversation field, and 418px receiver guide.
- Surface sampling: reference center is approximately `#031114`; implementation center is `#031114`. Reference side fields are approximately `#030f12`; implementation side fields are `#030f12`.
- Header, first timeline row, unread divider, composer, and status strip align to the reference rhythm.
- The receiver plate is a real raster asset, enlarged to fill the diagram field and feathered into the exact panel color with a radial CSS mask. There is no hard rectangular image boundary.
- The right rail keeps the reference sequence: transmission facts, receiver diagram, caption, Guide Note, and technical footer.
- The transmission index now uses `NIGHT RECEIVER CONSOLE`, `8 tuned`, `DIRECT TRANSMISSIONS`, mixed teal/red entry codes, and the same room-content density as the target.

## Mobile comparison

- Viewport: exactly 390 x 844 CSS pixels.
- Header title begins at x109; message copy begins at x101; timeline markers center at x78.
- Composer measures x9, y770, width 371px, height 37px. Status begins at y812.
- The desktop guide rail is hidden.
- `Guide Footnote` is absent and was not replaced by another card, caption, or decorative block. The space remains open dark field as requested.
- Search, details, attachment, emoji, and send controls remain available with labelled buttons.

## Interaction and motion

- Browser history navigation is coordinated between the room index and room URLs.
- Mobile edge swipes use Pointer Events with direction locking, velocity/distance thresholds, interactive-control exclusions, and reduced-motion handling.
- Unit coverage confirms left-edge open, leftward close, vertical-scroll rejection, and wrong-way rejection.
- CSS transitions use transform and opacity, and the existing reduced-motion override disables nonessential movement.

## Verification

- `npm run lint`: passed.
- `npm run typecheck`: passed.
- `npm run test:unit`: 83 passed, 3 skipped, 0 failed.
- `npm run build`: passed.
- Desktop browser console: 0 warnings, 0 errors.
- Mobile browser console: 0 warnings, 0 errors.

## Residual differences

- [P3] The implementation uses the existing Lucide icon set instead of reproducing the reference's hand-drawn symbols.
- [P3] Font rasterization and the receiver illustration's individual line details are not pixel-identical, while geometry, hierarchy, palette, and theme treatment match.

No actionable P0, P1, or P2 visual differences remain.

final result: passed
