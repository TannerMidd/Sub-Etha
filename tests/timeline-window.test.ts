import assert from "node:assert/strict";
import test from "node:test";
import {
    countPrependedTimelineItems,
    INITIAL_TIMELINE_ITEM_INDEX,
    timelineStartIndexAfterPrepend,
} from "../lib/timeline-window";

test("timeline prepends preserve the existing first item position", () => {
    const nextIds = ["older-1", "older-2", "current-1", "current-2"];

    assert.equal(countPrependedTimelineItems("current-1", nextIds), 2);
    assert.equal(
        timelineStartIndexAfterPrepend(INITIAL_TIMELINE_ITEM_INDEX, "current-1", nextIds),
        INITIAL_TIMELINE_ITEM_INDEX - 2,
    );
});

test("appends and same-id timeline refreshes do not move the logical start", () => {
    const currentStart = INITIAL_TIMELINE_ITEM_INDEX - 40;

    assert.equal(timelineStartIndexAfterPrepend(currentStart, "current-1", ["current-1", "current-2", "new"]), currentStart);
    assert.equal(timelineStartIndexAfterPrepend(currentStart, null, ["current-1"]), currentStart);
});

test("a replaced limited timeline does not invent a prepend offset", () => {
    const currentStart = INITIAL_TIMELINE_ITEM_INDEX - 40;

    assert.equal(timelineStartIndexAfterPrepend(currentStart, "missing", ["replacement-1", "replacement-2"]), currentStart);
});

test("timeline start indexes never become negative", () => {
    assert.equal(timelineStartIndexAfterPrepend(1, "current", ["older-1", "older-2", "current"]), 0);
});
