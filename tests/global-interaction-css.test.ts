import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const GLOBAL_STYLES = new URL("../app/styles/globals.scss", import.meta.url);

test("global app chrome suppresses browser tap, callout, and selection highlights", async () => {
    const css = await readFile(GLOBAL_STYLES, "utf8");
    const globalRule = css.match(/^\*,\s*\*::before,\s*\*::after\s*\{([^}]*)\}/m)?.[1] ?? "";

    assert.match(globalRule, /-webkit-tap-highlight-color\s*:\s*transparent/);
    assert.match(globalRule, /-webkit-touch-callout\s*:\s*none/);
    assert.match(globalRule, /-webkit-user-select\s*:\s*none/);
    assert.match(globalRule, /(?:^|\s)user-select\s*:\s*none/);
    assert.doesNotMatch(css, /(?:^|\n)::selection\s*\{/);
});

test("editable fields restore selection and editing callouts", async () => {
    const css = await readFile(GLOBAL_STYLES, "utf8");

    assert.match(css, /textarea:not\(\[disabled\], \[readonly\]\)/);
    assert.match(css, /\[contenteditable\]:not\(\[contenteditable="false"\]\)/);
    assert.match(css, /-webkit-touch-callout\s*:\s*default/);
    assert.match(css, /-webkit-user-select\s*:\s*text/);
    assert.match(css, /(?:^|\s)user-select\s*:\s*text/);
    assert.match(css, /\)\s*::selection\s*\{/);
});
