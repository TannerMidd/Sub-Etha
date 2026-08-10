import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const GLOBALS_CSS = new URL("../app/globals.css", import.meta.url);

test("timeline styles leave Virtuoso spacer geometry untouched", async () => {
    const css = await readFile(GLOBALS_CSS, "utf8");
    const virtuosoInternalSelector = /\.timeline\s*>\s*div\s*>\s*div\s*>\s*div(?:[^,{]*)?\s*\{/;

    assert.doesNotMatch(
        css,
        virtuosoInternalSelector,
        "Style message elements through their own classes; Virtuoso owns its nested spacer padding and transforms.",
    );
});
