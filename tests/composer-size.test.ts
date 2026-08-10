import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposerTextareaSize } from "../lib/composer-size";

test("composer height respects its minimum and includes borders", () => {
    assert.deepEqual(resolveComposerTextareaSize(20, 44, 152, 2), {
        height: 44,
        overflowing: false,
    });
    assert.deepEqual(resolveComposerTextareaSize(86, 44, 152, 2), {
        height: 88,
        overflowing: false,
    });
});

test("composer height caps at six lines and only then enables overflow", () => {
    assert.deepEqual(resolveComposerTextareaSize(149, 44, 152, 2), {
        height: 151,
        overflowing: false,
    });
    assert.deepEqual(resolveComposerTextareaSize(171, 44, 152, 2), {
        height: 152,
        overflowing: true,
    });
});
