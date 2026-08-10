import assert from "node:assert/strict";
import test from "node:test";
import {
    canStartMobileSwipe,
    guideEntryCode,
    resolveMobileSwipe,
    shouldDeferRoomHistorySeed,
} from "../lib/guide-navigation";

test("guide entry codes are short, stable, and room-specific", () => {
    assert.match(guideEntryCode("!signal-watch:example.org"), /^\d{2}-[A-F]$/);
    assert.equal(
        guideEntryCode("!signal-watch:example.org"),
        guideEntryCode("!signal-watch:example.org"),
    );
    assert.notEqual(
        guideEntryCode("!signal-watch:example.org"),
        guideEntryCode("!quiet-corner:example.org"),
    );
});

test("a closed mobile index only accepts gestures from the left screen edge", () => {
    assert.equal(canStartMobileSwipe(20, false), true);
    assert.equal(canStartMobileSwipe(80, false), false);
    assert.equal(canStartMobileSwipe(220, true), true);
});

test("a valid direct room URL wins over the restored active room during history setup", () => {
    assert.equal(shouldDeferRoomHistorySeed("room-a", "room-b", ["room-a", "room-b"]), true);
    assert.equal(shouldDeferRoomHistorySeed("room-a", "room-a", ["room-a", "room-b"]), false);
    assert.equal(shouldDeferRoomHistorySeed("room-a", "missing", ["room-a", "room-b"]), false);
});

test("a deliberate right edge swipe opens the room index", () => {
    assert.equal(
        resolveMobileSwipe({
            startX: 18,
            endX: 126,
            startY: 360,
            endY: 372,
            elapsedMs: 240,
            viewportWidth: 390,
            indexOpen: false,
        }),
        "open-index",
    );
});

test("a deliberate left swipe closes an open room index", () => {
    assert.equal(
        resolveMobileSwipe({
            startX: 310,
            endX: 184,
            startY: 240,
            endY: 248,
            elapsedMs: 210,
            viewportWidth: 390,
            indexOpen: true,
        }),
        "close-index",
    );
});

test("vertical scrolls and wrong-way swipes do not navigate", () => {
    assert.equal(
        resolveMobileSwipe({
            startX: 18,
            endX: 76,
            startY: 180,
            endY: 360,
            elapsedMs: 180,
            viewportWidth: 390,
            indexOpen: false,
        }),
        null,
    );
    assert.equal(
        resolveMobileSwipe({
            startX: 18,
            endX: 112,
            startY: 180,
            endY: 184,
            elapsedMs: 180,
            viewportWidth: 390,
            indexOpen: true,
        }),
        null,
    );
});
