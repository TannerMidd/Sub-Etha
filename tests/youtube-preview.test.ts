import assert from "node:assert/strict";
import test from "node:test";
import {
    BoundedYouTubeThumbnailFailureStore,
    isTimelineYouTubePreviewEligible,
    parseYouTubeVideoIds,
    timelineYouTubePreviews,
    youtubePreviewLayout,
    youtubeThumbnailUrl,
    youtubeWatchUrl,
    YOUTUBE_PREVIEW_GAP_PX,
    YOUTUBE_PREVIEW_METADATA_HEIGHT_PX,
    YOUTUBE_PREVIEW_MAX_WIDTH_PX,
    YOUTUBE_PREVIEW_SCAN_LIMIT,
} from "../lib/youtube-preview";

const ID_A = "Abc_def-123";
const ID_B = "Zyx98765432";
const ID_C = "qwertyuiop1";
const validShort = `https://youtu.be/${ID_A}`;

function previewItem(overrides: Record<string, unknown> = {}) {
    return {
        body: `${validShort} and https://www.youtube.com/watch?v=${ID_B}`,
        type: "message",
        decryptionState: "ready",
        redacted: false,
        media: undefined,
        sendingStatus: null,
        ...overrides,
    };
}

test("parses only the frozen YouTube URL forms and exact ID rules", () => {
    assert.deepEqual(parseYouTubeVideoIds(validShort), [ID_A]);
    assert.deepEqual(parseYouTubeVideoIds(`https://youtube.com/shorts/${ID_A}`), [ID_A]);
    assert.deepEqual(parseYouTubeVideoIds(`https://www.youtube.com/embed/${ID_A}`), [ID_A]);
    assert.deepEqual(parseYouTubeVideoIds(`https://m.youtube.com/live/${ID_A}`), [ID_A]);
    assert.deepEqual(
        parseYouTubeVideoIds(`https://www.youtube.com/watch?v=${ID_A}&t=1m30s&list=abc_1`),
        [ID_A],
    );
    assert.equal(youtubeThumbnailUrl(ID_A), `https://i.ytimg.com/vi/${ID_A}/hqdefault.jpg`);
    assert.equal(youtubeWatchUrl(ID_A), `https://www.youtube.com/watch?v=${ID_A}`);

    const rejected = [
        `https://youtu.be/${ID_A}/`,
        `https://youtu.be/${ID_A}?v=${ID_A}`,
        `https://youtube.com/watch?v=${ID_A}&v=${ID_B}`,
        `https://youtube.com/watch?V=${ID_A}`,
        `https://youtube.com/watch?v=${ID_A}&bad=x`,
        `https://youtube.com/watch?v=${ID_A}&t=`,
        `https://youtube.com/watch?v=${ID_A}&t=has%20space`,
        `https://youtube.com/watch?v=${ID_A}&t=1=2`,
        `https://youtube.com/watch?v=${ID_A}#fragment`,
        `https://youtube.com:443/watch?v=${ID_A}`,
        `https://www.youtube.com.evil/watch?v=${ID_A}`,
        `https://www.youtube.com//shorts/${ID_A}`,
        `https://www.youtube.com/./shorts/${ID_A}`,
        `https://www.youtube.com/shorts/${ID_A}/`,
        `HTTPS://youtu.be/${ID_A}`,
        `https://youtu.be/${ID_A.slice(0, 10)}`,
        `https://youtu.be/${ID_A}\\next`,
        `https://youtu.be/${ID_A}%2F`,
        `https://youtu.be/${ID_A}\u00a0next`,
        `https://user:pass@youtu.be/${ID_A}`,
    ];

    for (const value of rejected) {
        assert.deepEqual(parseYouTubeVideoIds(value), [], value);
    }
});

test("dedupes valid IDs after at most 32 raw tokens and returns three cards", () => {
    assert.deepEqual(
        parseYouTubeVideoIds(
            [
                validShort,
                `https://www.youtube.com/watch?v=${ID_A}`,
                `https://youtu.be/${ID_B}`,
                `https://youtube.com/shorts/${ID_C}`,
                `https://youtu.be/${ID_A}`,
            ].join(" "),
        ),
        [ID_A, ID_B, ID_C],
    );

    const invalidTokens = Array.from(
        { length: 32 },
        (_, index) => `https://invalid.example/${index}`,
    );

    assert.deepEqual(parseYouTubeVideoIds(`${invalidTokens.join(" ")} ${validShort}`), []);
});

test("bounds clipping never accepts a URL whose token is cut at the scan boundary", () => {
    assert.deepEqual(
        parseYouTubeVideoIds(`${validShort} ${"x".repeat(YOUTUBE_PREVIEW_SCAN_LIMIT)}`),
        [ID_A],
    );
    assert.deepEqual(
        parseYouTubeVideoIds(
            `${"x".repeat(YOUTUBE_PREVIEW_SCAN_LIMIT - validShort.length + 1)}${validShort}`,
        ),
        [],
    );
});

test("timeline eligibility, render policy, and geometry stay in one bounded contract", () => {
    const item = previewItem();
    const previews = timelineYouTubePreviews(item);

    assert.equal(isTimelineYouTubePreviewEligible(item), true);
    assert.equal(isTimelineYouTubePreviewEligible({ ...item, type: "notice" }), true);
    assert.deepEqual(
        previews.map((preview) => ({ id: preview.id, src: preview.src, href: preview.href })),
        [
            { id: ID_A, src: youtubeThumbnailUrl(ID_A), href: youtubeWatchUrl(ID_A) },
            { id: ID_B, src: youtubeThumbnailUrl(ID_B), href: youtubeWatchUrl(ID_B) },
        ],
    );
    assert.deepEqual(timelineYouTubePreviews({ ...item, media: {} }), []);
    assert.deepEqual(timelineYouTubePreviews({ ...item, type: "image" }), []);
    assert.deepEqual(timelineYouTubePreviews({ ...item, redacted: true }), []);
    assert.deepEqual(timelineYouTubePreviews({ ...item, sendingStatus: "sending" }), []);
    assert.deepEqual(timelineYouTubePreviews({ ...item, sendingStatus: true }), []);
    assert.deepEqual(timelineYouTubePreviews({ ...item, decryptionState: "decrypting" }), []);

    const layout = youtubePreviewLayout(720, previews.length);

    assert.equal(layout.width, YOUTUBE_PREVIEW_MAX_WIDTH_PX);
    assert.equal(layout.imageHeight, 360);
    assert.equal(layout.cardHeight, 360 + YOUTUBE_PREVIEW_METADATA_HEIGHT_PX);
    assert.equal(layout.totalHeight, 8 + layout.cardHeight * 2 + YOUTUBE_PREVIEW_GAP_PX);
    assert.equal(youtubePreviewLayout(274, 3).width, 274);
});

test("thumbnail failure store is FIFO, bounded, and duplicate marks do not reorder", () => {
    const store = new BoundedYouTubeThumbnailFailureStore(2);

    store.markFailed(ID_A);
    store.markFailed(ID_B);
    store.markFailed(ID_A);
    assert.deepEqual(store.ids(), [ID_A, ID_B]);

    store.markFailed(ID_C);
    assert.deepEqual(store.ids(), [ID_B, ID_C]);
    assert.equal(store.size, 2);
    assert.equal(store.has(ID_A), false);
});
