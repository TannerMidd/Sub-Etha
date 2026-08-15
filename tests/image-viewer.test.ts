import assert from "node:assert/strict";
import test from "node:test";
import {
    clampViewerZoom,
    containImageSize,
    MAX_VIEWER_ZOOM,
    MIN_VIEWER_ZOOM,
    pinchViewerZoom,
    preserveScrollCenter,
    stepViewerZoom,
} from "../lib/image-viewer";

function assertSize(
    actual: { width: number; height: number },
    expected: { width: number; height: number },
): void {
    assert.ok(
        Math.abs(actual.width - expected.width) < 0.001,
        `${actual.width} should equal ${expected.width}`,
    );
    assert.ok(
        Math.abs(actual.height - expected.height) < 0.001,
        `${actual.height} should equal ${expected.height}`,
    );
}

test("fit-first sizing contains wide, tall, square, and small images without upscaling", () => {
    assertSize(containImageSize({ width: 4000, height: 2000 }, { width: 1200, height: 700 }), {
        width: 1200,
        height: 600,
    });
    assertSize(containImageSize({ width: 1000, height: 4000 }, { width: 1200, height: 700 }), {
        width: 175,
        height: 700,
    });
    assertSize(containImageSize({ width: 3000, height: 3000 }, { width: 1200, height: 700 }), {
        width: 700,
        height: 700,
    });
    assertSize(containImageSize({ width: 320, height: 240 }, { width: 1200, height: 700 }), {
        width: 320,
        height: 240,
    });
});

test("viewer zoom uses deliberate 25 percent steps between fit and 400 percent", () => {
    assert.equal(stepViewerZoom(MIN_VIEWER_ZOOM, 1), 1.25);
    assert.equal(stepViewerZoom(1.25, -1), MIN_VIEWER_ZOOM);
    assert.equal(clampViewerZoom(0.25), MIN_VIEWER_ZOOM);
    assert.equal(clampViewerZoom(8), MAX_VIEWER_ZOOM);
    assert.equal(stepViewerZoom(MAX_VIEWER_ZOOM, 1), MAX_VIEWER_ZOOM);
});

test("pinch zoom scales from the gesture start and stays within viewer limits", () => {
    assert.equal(pinchViewerZoom(1, 100, 150), 1.5);
    assert.equal(pinchViewerZoom(2, 200, 100), 1);
    assert.equal(pinchViewerZoom(3, 100, 200), MAX_VIEWER_ZOOM);
    assert.equal(pinchViewerZoom(1, 100, 10), MIN_VIEWER_ZOOM);
    assert.equal(pinchViewerZoom(2, 0, 100), 2);
});

test("zooming preserves the centered image point and clamps every edge", () => {
    assert.equal(preserveScrollCenter(0, 1200, 1200, 2400), 600);
    assert.equal(preserveScrollCenter(300, 1200, 1800, 2400), 600);
    assert.equal(preserveScrollCenter(0, 1000, 2000, 3000), 250);
    assert.equal(preserveScrollCenter(1000, 1000, 2000, 3000), 1750);
    assert.equal(preserveScrollCenter(-500, 1000, 2000, 3000), 0);
    assert.equal(preserveScrollCenter(2000, 1000, 2000, 3000), 2000);
    assert.equal(preserveScrollCenter(500, 1200, 2400, 900), 0);
});
