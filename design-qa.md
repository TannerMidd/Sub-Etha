# Sub-Etha Night Receiver Design QA

## Comparison target

- Source visual truth: `C:\Users\Tanner\.codex\generated_images\019fdf8a-e581-7293-a4b5-e8256cae2d7c\exec-9f996a44-0b7e-4f30-bf7c-556e96908dd0.png`
- Browser-rendered implementation: `F:\Development\Sub-Etha\design-implementation-final.png`
- Full-view comparison: `F:\Development\Sub-Etha\design-comparison-final.png`
- Focused header/navigation comparison: `F:\Development\Sub-Etha\design-comparison-focus-top.png`
- Focused composer/status comparison: `F:\Development\Sub-Etha\design-comparison-focus-bottom.png`
- Responsive evidence: `F:\Development\Sub-Etha\design-mobile-conversation.png` and `F:\Development\Sub-Etha\design-mobile-rooms.png`
- State: dark theme, encrypted `Signal Watch` room, populated conversation, unread marker visible, composer idle.

## Normalization

- Source pixels: 1672 × 941.
- Implementation pixels: 1600 × 900.
- Browser CSS viewport: 1600 × 900; reported device pixel ratio: 2; the in-app browser capture was normalized to 1600 × 900 output pixels.
- The source was resized to 1600 × 900 for focused crops. The full-view comparison places both artifacts at 800 × 450, preserving their shared 16:9 composition.
- Mobile captures use a 390 × 844 CSS viewport.

## Full-view comparison evidence

The implementation matches the selected direction's major composition: a 380px receiver/navigation shell, a 110px room command header, a conversation-first reading column, a dedicated signal-guide illustration field, an anchored composer, and a three-part receiver status footer. The room rail, active-room treatment, signal-red action, teal trust states, warm ivory type, near-black blue-green surfaces, fine dividers, and restrained scientific labels follow the source hierarchy.

No actionable P0, P1, or P2 differences remain.

## Focused comparison evidence

- Typography: the implementation uses the established Sub-Etha display, UI, and mono stacks with matching condensed branding, 15px message copy, compact metadata, and high-contrast warm-ivory text. Wrapping and truncation remain stable in both desktop and mobile captures.
- Spacing and layout rhythm: the navigation rail, room rows, message cadence, header commands, unread divider, composer, and bottom status strip align closely with the source. Persistent controls remain visible at 1600 × 900 and 390 × 844.
- Colors and visual tokens: the dark tokens now map to the source's #071312-class background, oxidized teal states, parchment text, hairline green-gray dividers, and restrained signal red.
- Image quality: `public/night-receiver-plate.png` is a dedicated raster illustration generated for this placement. It is sharp, correctly scaled, and blends into the dark surface without a visible frame. Matrix-provided avatars remain dynamic product content rather than being replaced with decorative app-owned images.
- Copy and content: receiver labels are concise and product-specific. Encryption and destructive language remain direct. The timeline preserves realistic Matrix states while the surrounding voice stays dry and lightly cosmic.

## Interaction and accessibility checks

- Room-view rail: all rooms, unread, favourites, and invitations filters exercised successfully.
- Room search: opened, filtered to `Maris`, cleared, and retained keyboard-accessible labeling.
- Room switching: switched from `Signal Watch` to `Maris` and back; header and active state updated.
- Messaging: composed and sent `Receiver check complete.` in the local preview; local timeline updated.
- Message search: searched for `carrier` and received the expected result.
- Mobile navigation: opened the stacked room list, scrolled rooms, and returned to the conversation layout.
- Focus states remain visible; controls have accessible names; reduced-motion behavior is preserved.
- Browser console: zero warnings or errors in the final desktop state.

## Comparison history

### Iteration 1

- [P2] The timeline scrollbar was visually dominant and interrupted the two-field composition.
- [P2] The selected design's unread divider was missing.
- [P2] The field-guide illustration was underscaled and the composer/status stack consumed too much vertical space.

Fixes: hid the decorative scroll track while retaining wheel/touch scrolling, added a semantic unread divider, enlarged the dedicated illustration asset, removed idle typing-line height, tightened the composer, and reduced the receiver footer height.

Post-fix evidence: `design-comparison-final.png`, `design-comparison-focus-top.png`, and `design-comparison-focus-bottom.png` show the corrected proportions and states.

## Follow-up polish

- [P3] The mock uses curated planet portraits; production correctly displays homeserver-provided Matrix avatars and initials when avatars are absent.
- [P3] The mock depicts formatting and emoji composer controls. They remain omitted until those actions have complete product behavior rather than appearing as decorative chrome.
- [P3] Room rows intentionally retain last-message previews instead of replacing them with member counts, because that information is more useful for daily scanning.

final result: passed
