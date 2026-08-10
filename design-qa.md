# Sub-Etha Compact Dark Guide QA

## Source and implementation evidence

- Desktop art-direction reference: `designs/sub-etha-night-edition-desktop-1920x1080.png`
- Desktop implementation capture: `designs/sub-etha-compact-dark-desktop-1920x1080.png`
- Desktop full-view comparison: `designs/design-qa-desktop-comparison.png`
- Desktop Guide-rail comparison: `designs/design-qa-guide-rail-comparison.png`
- Mobile art-direction reference: `designs/sub-etha-night-edition-mobile-390x844.png`
- Mobile implementation capture: `designs/sub-etha-compact-dark-mobile-390x844.png`
- Mobile full-view comparison: `designs/design-qa-mobile-comparison.png`
- Mobile composer comparison: `designs/design-qa-mobile-composer-comparison.png`
- Browser route: `/?design-preview#/room/signal-watch`

Both implementation captures are PNG browser renders at device-pixel ratio 1. The desktop capture is 1920 x 1080 pixels and the mobile capture is 390 x 844 pixels. The tested state is the dark `Signal Watch` design-preview fixture with an empty one-line composer.

## Measured desktop result

- Shell: 1920 x 1080.
- Grid: 312px navigation, 1264px conversation, and 344px Guide rail.
- Header: 104px. Conversation title: 38px / 42px Roboto Condensed Variable.
- Message copy: 16px / 24px Inter Variable with an 820px maximum reading measure.
- Timeline stage: 856px. Typing strip: 28px. Composer: 52px. Status strip: 40px.
- Guide illustration field: 296 x 296px.
- Primary surface: `#031013`.
- The receiver illustration uses `night-receiver-linework.png`, an alpha-transparent derivative of the supplied source. It has no CSS filter, mask, blend mode, enlargement, or opaque backing rectangle.

## Measured mobile result

- Shell: 390 x 844.
- Header: 56px. Conversation title: 26px / 30px.
- Message copy: 15px / 22px.
- Timeline stage: 680px in the empty-composer fixture. Typing strip: 28px. Composer: 48px. Status strip: 32px.
- Textarea: 42px minimum and 142px maximum. Header actions: two 44 x 44px targets.
- The Guide rail is `display: none` and no `Guide Footnote` text or replacement card exists.
- Room information remains reachable through the labelled Details control.

## Interaction and behavior acceptance

- Rapid real wheel scrolling never creates a `.timeline-scroll-seek` placeholder.
- Attached timelines keep the newest row at least 12px above the scrollport edge.
- Detached timelines preserve their first visible event within 2px through twenty message mutations, decryption, media measurement, reactions, edits, and a remote append.
- History pagination preserves its anchor, rejects concurrent requests, exposes retry after failure, stops at token exhaustion, and can still return to the newest message.
- Composer coverage includes one, four, six, and eight lines, paste, resize, reply, edit cancellation, clear, and send.
- Real Chromium touch input verifies edge-swipe open/close, vertical-scroll priority, dialog/control exclusions, header Back, browser Back, and reduced motion.
- The mobile reply/edit tray remains hit-testable with 44px controls after virtualized scrolling; a ten-run repetition passed.
- Fresh desktop and mobile browser tabs reported zero console warnings and zero console errors.

## Visual findings and iteration history

1. [P1 fixed] The original receiver derivative retained excess alpha padding and under-filled the rail. The final derivative was regenerated from the supplied artwork, cropped to its alpha bounds, and rendered without theme-altering effects.
2. [P1 fixed] Desktop and mobile composer wrappers were 8px too tall. They now measure 52px and 48px respectively while retaining six-line expansion.
3. [P1 fixed] The second mobile header command and Send label were hidden by competing responsive rules. Both are visible and retain 44px targets.
4. [P1 fixed] The mobile message-action tray could be clipped or lose its open state while Virtuoso recycled a settling row. The tray is now measurement-neutral, and browser hit testing waits for the virtualized row to settle.
5. [P2 intentional] The implementation is denser than the oversized art-direction reference: the desktop rails, type, and controls use the compact dimensions requested in the implementation plan.
6. [P2 intentional] The mobile Guide Footnote present in the reference is removed rather than reproduced.
7. [P3] The implementation keeps the existing Lucide icon language rather than tracing the reference symbols exactly.

No actionable P0, P1, or P2 visual differences remain.

## Verification

- Repository-wide Prettier write and `format:check`: passed.
- ESLint: passed.
- TypeScript typecheck: passed.
- Unit suite: 95 passed, 3 skipped, 0 failed.
- Playwright suite: 20 passed, 4 desktop-only mobile-test skips, 0 failed.
- Mobile message-action repetition: 10 passed, 0 failed.
- Production build: passed.
- Stable visual snapshots use `maxDiffPixelRatio: 0.005`.

final result: passed
