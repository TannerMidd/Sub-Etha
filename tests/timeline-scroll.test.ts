import assert from "node:assert/strict";
import test from "node:test";
import {
    classifyTimelineChange,
    shouldScrollTimelineToBottom,
    timelineAttachmentAfterBottomStateChange,
    type TimelineIdentity,
} from "../lib/timeline-scroll";

const item = (id: string, own = false): TimelineIdentity => ({ id, own });

test("initial and replacement timelines position at the bottom", () => {
    const initial = classifyTimelineChange([], [item("one")], 1_000, 1_000);
    const replacement = classifyTimelineChange([item("old")], [item("new")], 1_000, 1_000);

    assert.equal(initial.kind, "initial");
    assert.equal(replacement.kind, "replace");
    assert.equal(shouldScrollTimelineToBottom(initial, false), true);
    assert.equal(shouldScrollTimelineToBottom(replacement, false), true);
});

test("prepending history preserves the current anchor", () => {
    const change = classifyTimelineChange(
        [item("current-1"), item("current-2")],
        [item("older-1"), item("older-2"), item("current-1"), item("current-2")],
        1_000,
        998,
    );

    assert.equal(change.kind, "prepend");
    assert.equal(shouldScrollTimelineToBottom(change, true), false);
});

test("remote appends follow only while attached", () => {
    const change = classifyTimelineChange(
        [item("one"), item("two")],
        [item("one"), item("two"), item("remote")],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "append");
    assert.equal(change.appendedOwnItem, false);
    assert.equal(shouldScrollTimelineToBottom(change, true), true);
    assert.equal(shouldScrollTimelineToBottom(change, false), false);
});

test("local appends always reveal the sent message", () => {
    const change = classifyTimelineChange(
        [item("one")],
        [item("one"), item("mine", true)],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "append");
    assert.equal(change.appendedOwnItem, true);
    assert.equal(shouldScrollTimelineToBottom(change, false), true);
});

test("same-id updates preserve detached history and follow while attached", () => {
    const change = classifyTimelineChange(
        [item("one"), item("two")],
        [item("one"), item("two")],
        1_000,
        1_000,
    );

    assert.equal(change.kind, "items-change");
    assert.equal(shouldScrollTimelineToBottom(change, false), false);
    assert.equal(shouldScrollTimelineToBottom(change, true), true);
});

test("returning to the bottom re-enables following without layout changes detaching it", () => {
    assert.equal(timelineAttachmentAfterBottomStateChange(false, true), true);
    assert.equal(timelineAttachmentAfterBottomStateChange(true, false), true);
    assert.equal(timelineAttachmentAfterBottomStateChange(false, false), false);
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
