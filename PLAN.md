# iPhone Web Push Reliability Plan

## Goal

Make Sub-Etha's installed iPhone PWA deliver reliable generic Matrix notifications without violating WebKit's `userVisibleOnly` contract or weakening the existing privacy-minimal push boundary.

## Problem statement

A phone-initiated test notification can arrive while real Matrix notifications later disappear. The current implementation creates subscriptions with `userVisibleOnly: true`, but intentionally handles several provider-delivered pushes without showing a notification:

- endpoint-confirmation challenges return silently;
- count-only Matrix callbacks update only the app badge;
- Matrix events are suppressed when a service-worker window client is reported as visible;
- stale, malformed, or unowned push payloads can return without a visible result.

WebKit requires a visible notification in response to every received push for a `userVisibleOnly` subscription and may revoke subscriptions after silent pushes. WebKit also states that a badge update alone does not satisfy that requirement:

- <https://webkit.org/blog/12945/meet-web-push/>
- <https://webkit.org/blog/14112/badging-for-home-screen-web-apps/>

The server currently forwards count-only Matrix callbacks to Web Push even though the worker deliberately does not alert for them. That creates routine silent push events on iOS. A phone test does not exercise the Matrix callback path and therefore cannot detect this failure mode.

## Success criteria

1. Count-only Matrix callbacks do not contact a Web Push provider.
2. Every server-generated push that reaches the service worker produces a generic visible notification, including registration challenges.
3. Event-bearing Matrix notifications alert even if iOS reports an existing PWA window as visible.
4. No notification contains sender, room name, message text, account identity, capability, or challenge material.
5. Notification clicks carry room/event routing only when the worker has verified the current local push configuration; fallback notifications open the app root.
6. Existing iPhone subscriptions that were revoked or rotated are reconciled when the user next opens an unlocked session and authoritative page-side capabilities remain available, without requiring a trip through Settings.
7. Completed logout/disable cleanup still removes the gateway subscription, browser subscription, worker configuration, displayed notifications, and badge. An unavoidable in-flight fallback may be generic only and must contain no Matrix routing data.
8. Unit, integration, build, lint, formatting, and browser checks pass.

## Non-goals

- Rich notification content or server-side Matrix decryption.
- Broadcasting the Settings `Test` action to other devices; tests remain device-local.
- Persisting Matrix user IDs, room IDs, content, or per-user presence in the backend.
- Adding server-side foreground/visibility tracking.
- Adding a database migration unless implementation proves one is unavoidable.
- Adopting Declarative Web Push in this change; support and fallback behavior can be evaluated separately.

## Implementation plan

### 1. Encode the delivery policy at the gateway boundary

**Files:** `lib/push-server.ts`, `lib/push-gateway.ts`, `tests/push-server.test.ts`, possibly `tests/core.test.ts`

- Normalize an event-bearing Matrix callback as one with a non-empty string `event_id`.
- In the Matrix delivery path, detect count-only callbacks before consuming per-subscription delivery rate or outbound-provider budget.
- Return the existing non-rejected/suppressed Matrix result for count-only callbacks without calling `webpush.sendNotification()`.
- Continue returning HTTP success to the homeserver so count updates are not retried as delivery failures.
- Preserve endpoint validation and stale-subscription cleanup where useful, but do not treat a count-only callback as proof that the provider endpoint is still active.
- Keep test notifications on their existing management-capability path; they must still contact only the browser that initiated the test.
- Add privacy-safe aggregate logging that distinguishes event-bearing delivery from count-only suppression without logging event IDs, room IDs, push keys, endpoints, or account information.

**Tests:**

- A callback with unread counts and no `event_id` returns success and performs zero provider sends.
- A callback with a non-empty `event_id` still sends exactly once.
- Empty-string `event_id` is treated as count-only.
- Count-only suppression does not consume outbound-delivery budget or create a deduplication lease.
- Logs expose only aggregate classifications and counts.

### 2. Make the service worker user-visible by construction

**Files:** `public/sw.js`, `tests/service-worker.test.ts`, `tests/service-worker-cache.test.ts`

- Remove `hasVisibleWindow()` and the foreground visibility gate. Once an event-bearing push has reached the worker, always show the generic alert.
- Bind each event/test payload to the subscription's SHA-256 delivery-key hash. Treat that hash only as a non-authorizing opaque owner marker, compare it with a worker-computed hash of the current delivery capability, and keep the independently random local generation for lifecycle fencing.
- Keep room tags for valid, current event-bearing pushes so repeated events in one room continue to collapse.
- Treat a no-event Matrix payload received despite the server filter as a defensive fallback: show a generic notification and update the badge rather than handling it silently.
- Treat malformed or unowned ordinary payloads as generic fallback notifications. Do not attach room/event routing data unless the current worker configuration has been verified.
- Use a dedicated fallback tag and root navigation target for payloads that cannot be tied safely to the current delivery owner and local generation.
- Keep badge updates best-effort and subordinate to notification display; badge API failure must not prevent the visible alert.
- Preserve generation serialization for valid configuration, badge, dismissal, and cleanup operations. Where the current “never recreate after cleanup” test conflicts with an already-delivered WebKit push, refine the invariant to:
    - cleanup closes all notifications whose delivery began before cleanup completed;
    - any truly late/in-flight fallback is generic, has no room/event routing, and opens the app root;
    - no stale generation may alter the newer generation's badge or replace its tagged notification.

**Tests:**

- Background event-bearing pushes display and update the badge.
- A visible client no longer suppresses an event-bearing notification.
- A defensively received count-only push displays a generic fallback and updates the badge.
- Malformed/unowned pushes display a generic root-only fallback.
- Badge failures do not block `showNotification()`.
- Room grouping and notification-click routing still work when both the delivery owner and current local generation are verified.
- Stale-generation and cleanup races cannot attach stale routing data, mutate a newer badge, or leave a pre-cleanup notification displayed.

### 3. Make endpoint confirmation visible

**Files:** `public/sw.js`, `lib/matrix/notifications.ts`, `tests/service-worker.test.ts`, `tests/notifications-cleanup.test.ts`

- Keep endpoint ownership confirmation; do not remove the challenge security boundary.
- When a `subscription-challenge` push arrives, immediately show a one-time generic setup notification such as “Notifications are ready to receive transmissions.”
- Never place the challenge, delivery capability, management capability, endpoint, or generation in visible text or notification click data.
- Continue PATCHing the challenge to `/api/push/subscriptions` and notifying open page clients only after successful confirmation.
- On challenge failure or generation mismatch, retain the durable setup/cleanup behavior. The visible notification remains generic and opens the app root.
- Ensure initial enrollment and `pushsubscriptionchange` renewal use the same visible confirmation behavior.
- Use a stable setup tag so repeated or retried confirmations replace rather than stack setup notifications.

**Tests:**

- Initial and renewal challenges each call `showNotification()`.
- Challenge confirmation still happens only for the matching current generation.
- A stale or failed challenge does not expose data and cannot confirm registration, but is not handled as a silent push.
- Lost worker-to-page confirmation still succeeds through the existing idempotent gateway probe.

### 4. Repair affected subscriptions on normal startup

**Files:** `app/components/SubEthaApp.tsx` and/or `app/components/ChatShell.tsx`, `lib/matrix/notifications.ts`, relevant notification/session UI tests

- After an existing session is unlocked and the Matrix service is started, run one background `refreshPushState(service)` when local push credentials exist or worker push artifacts indicate prior enrollment.
- Keep page-side capabilities authoritative: reconcile an existing subscription only from local page credentials; when only worker/browser artifacts remain, run verified cleanup rather than promoting the worker replica into authoritative state.
- Do not request notification permission automatically. Reconciliation or orphan cleanup is allowed only when permission is already granted and prior local push state exists.
- Reuse the existing lifecycle lock and durable setup/cleanup journal so startup reconciliation cannot race Settings, logout, account replacement, or another tab.
- Keep startup usable if reconciliation fails. Surface the existing actionable notification error in Settings rather than blocking Matrix startup.
- Deduplicate startup and Settings reconciliation within one document so opening Settings during startup does not run two independent repair attempts.

**Tests:**

- An unlocked session with granted permission and prior push credentials reconciles once.
- A revoked/missing browser subscription is recreated and re-registered.
- A fresh account with no prior push state is not prompted and creates no subscription.
- Denied/default permission does not trigger a permission prompt.
- Reconciliation failure does not prevent chat startup and remains retryable.
- Logout or cleanup intent wins over an in-flight startup reconciliation.

### 5. Preserve privacy and lifecycle guarantees

**Files:** `tests/push-security.test.ts`, `tests/notifications-cleanup.test.ts`, `tests/security-client.test.ts`, documentation only where behavior statements require correction

- Verify all visible notification variants remain generic.
- Verify fallback clicks cannot navigate to unverified room/event identifiers.
- Verify server logs remain aggregate-only.
- Verify disable/logout still revoke the Matrix pusher and gateway/browser subscriptions and clear notifications/badges.
- Review ADRs 0008, 0010, and 0019 plus `docs/architecture.md`. Update current-behavior wording if needed, but do not create a new ADR unless implementation changes a trust boundary or state owner.
- Add a short implementation comment near the worker push handler linking the WebKit `userVisibleOnly` requirement so silent handling is not reintroduced as an optimization.

### 6. Validate and roll out

Run focused checks first:

```bash
node --import tsx --test tests/service-worker.test.ts tests/notifications-cleanup.test.ts tests/push-server.test.ts tests/push-security.test.ts
npm run typecheck
npm run lint
npm run format:check
```

Then run the complete release gate:

```bash
npm run check
```

Production verification:

1. Confirm `/sw.js` contains the new deployment build ID and no visibility suppression gate.
2. On an installed iPhone PWA, open an existing unlocked session and allow startup reconciliation to complete.
3. Confirm the one-time setup/repair notification appears when a new endpoint challenge is required.
4. Confirm a phone-initiated Test alerts only the phone.
5. With the PWA visible, backgrounded, and removed from the app switcher, confirm separate event-bearing Matrix messages each produce generic notifications.
6. Confirm desktop read-marker/count-only activity produces no provider push and no false phone alert.
7. Disable notifications and verify subsequent Matrix callbacks do not reach the phone and no badge/notification remains.
8. Inspect only aggregate production logs for `sent`, count-only `suppressed`, `rejected`, and `transient` outcomes; do not log payload identifiers to aid testing.

## Rollout order

The deployment should ship the gateway filter and service-worker behavior together. The safe compatibility direction is:

- new server + old worker: count-only pushes stop, reducing silent deliveries immediately;
- new server + new worker: event pushes always alert and challenges are visible;
- startup reconciliation repairs subscriptions affected before the deployment.

Do not deploy a worker that alerts for count-only payloads before the gateway filter is live, or desktop read/count activity may create false generic phone alerts.

## Risks and mitigations

- **Extra alerts while the PWA is foregrounded:** accepted tradeoff because provider-delivered pushes cannot be handled silently on WebKit. Room tags limit stacking.
- **One-time setup notification:** required by the endpoint-confirmation push design. Use a stable tag and generic wording.
- **Late push after logout:** provider delivery can race revocation. Any fallback must be generic, root-only, and stripped of routing data; cleanup closes notifications already known to the worker.
- **Loss of closed-app count-only badge refresh:** accepted. The badge refreshes from Matrix state when the app runs; sending a silent push solely for badging is not valid on WebKit.
- **Automatic repair causes network work at startup:** run only for prior enrollment, once per document, and never block chat startup.
- **Homeserver path remains externally dependent:** aggregate relay logs and the event/count classification provide a decisive diagnostic without expanding persisted Matrix data.

## Completion evidence

The implementation is complete when the final handoff includes:

- changed-file summary;
- focused and full command results;
- tests proving count-only callbacks never reach Web Push;
- tests proving every normal received push path is user-visible;
- tests proving startup repair and cleanup races remain safe;
- an installed-iPhone result for event, count-only, foreground, background, force-closed, repair, and disable flows;
- residual risks, especially any device-only behavior that could not be reproduced locally.
