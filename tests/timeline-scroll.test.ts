import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyTimelineChange,
    shouldFollowTimelineChange,
    transitionTimelineScrollMode,
    type TimelineIdentity,
} from "../lib/timeline-scroll";

const item = (id: string, local = false): TimelineIdentity => ({ id, local });

test("initial timelines position at the bottom without forcing detached replacements", () => {
    const initial = classifyTimelineChange([], [item("one")], 1_000, 1_000);
    const replacement = classifyTimelineChange([item("old")], [item("new")], 1_000, 1_000);

    assert.equal(initial.kind, "initial");
    assert.equal(replacement.kind, "replace");
    assert.equal(shouldFollowTimelineChange(initial, "detached"), true);
    assert.equal(shouldFollowTimelineChange(replacement, "detached"), false);
    assert.equal(shouldFollowTimelineChange(replacement, "attached"), true);
});

test("prepending history preserves the current anchor", () => {
    const change = classifyTimelineChange(
        [item("current-1"), item("current-2")],
        [item("older-1"), item("older-2"), item("current-1"), item("current-2")],
        1_000,
        998,
    );

    assert.equal(change.kind, "prepend");
    assert.equal(shouldFollowTimelineChange(change, "attached"), false);
});

test("remote appends follow only while attached", () => {
    const change = classifyTimelineChange(
        [item("one"), item("two")],
        [item("one"), item("two"), item("remote")],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "append");
    assert.equal(change.appendedLocalItem, false);
    assert.equal(shouldFollowTimelineChange(change, "attached"), true);
    assert.equal(shouldFollowTimelineChange(change, "detached"), false);
});

test("local appends always reveal the sent message", () => {
    const change = classifyTimelineChange(
        [item("one")],
        [item("one"), item("mine", true)],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "append");
    assert.equal(change.appendedLocalItem, true);
    assert.equal(shouldFollowTimelineChange(change, "detached"), true);
});

test("own-account messages synced from another device do not pull a detached reader", () => {
    const change = classifyTimelineChange(
        [item("one")],
        [item("one"), item("mine-on-another-device")],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "append");
    assert.equal(change.appendedLocalItem, false);
    assert.equal(shouldFollowTimelineChange(change, "detached"), false);
});

test("same-id refreshes do not issue redundant bottom scrolls", () => {
    const change = classifyTimelineChange(
        [item("one"), item("two")],
        [item("one"), item("two")],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "items-change");
    assert.equal(shouldFollowTimelineChange(change, "detached"), false);
    assert.equal(shouldFollowTimelineChange(change, "attached"), false);
});

test("bottom-state changes are authoritative", () => {
    assert.equal(
        transitionTimelineScrollMode("detached", { type: "bottom-state", atBottom: true }),
        "attached",
    );
    assert.equal(
        transitionTimelineScrollMode("attached", { type: "bottom-state", atBottom: false }),
        "detached",
    );
});

test("user intent cancels following and history restoration", () => {
    assert.equal(transitionTimelineScrollMode("attached", { type: "user-detach" }), "detached");
    assert.equal(
        transitionTimelineScrollMode("restoring-history", { type: "user-detach" }),
        "detached",
    );
});

test("history restoration returns to detached reading while local sends attach", () => {
    assert.equal(
        transitionTimelineScrollMode("detached", { type: "history-start" }),
        "restoring-history",
    );
    assert.equal(
        transitionTimelineScrollMode("restoring-history", { type: "history-complete" }),
        "detached",
    );
    assert.equal(transitionTimelineScrollMode("detached", { type: "local-append" }), "attached");
});

test("room changes initialize once before attaching", () => {
    assert.equal(transitionTimelineScrollMode("detached", { type: "room-change" }), "initializing");
    assert.equal(
        transitionTimelineScrollMode("initializing", { type: "initial-positioned" }),
        "attached",
    );
});

test("an unrelated same-length timeline is a replacement", () => {
    const change = classifyTimelineChange(
        [item("one"), item("two")],
        [item("three"), item("four")],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "replace");
});

test("a sliding same-room window preserves detached reading position", () => {
    const change = classifyTimelineChange(
        [item("one"), item("two"), item("three")],
        [item("two"), item("three"), item("four")],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "window-shift");
    assert.equal(shouldFollowTimelineChange(change, "detached"), false);
    assert.equal(shouldFollowTimelineChange(change, "attached"), true);
});

test("a local echo introduced during reconciliation still follows", () => {
    const change = classifyTimelineChange(
        [item("one"), item("pending")],
        [item("one"), item("confirmed", true)],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "window-shift");
    assert.equal(change.appendedLocalItem, true);
    assert.equal(shouldFollowTimelineChange(change, "detached"), true);
});
