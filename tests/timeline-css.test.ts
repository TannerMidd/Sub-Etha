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

test("timeline history controls remain available", async () => {
    const css = await readFile(GLOBALS_CSS, "utf8");
    const hiddenHistoryLoader = /\.history-loader\s*\{[^}]*display\s*:\s*none/;

    assert.doesNotMatch(
        css,
        hiddenHistoryLoader,
        "Earlier-history controls must not be hidden by theme overrides.",
    );
});

test("composer theme styles preserve the autosize contract", async () => {
    const css = await readFile(GLOBALS_CSS, "utf8");
    const composerRules = [...css.matchAll(/\.composer\s*\{([^}]*)\}/g)].map((match) => match[1]);

    assert.doesNotMatch(css, /max-height\s*:\s*(?:35|55)px/);
    assert.doesNotMatch(css, /flex\s*:\s*0\s+0\s+47px/);

    for (const rule of composerRules) {
        assert.doesNotMatch(
            rule,
            /^\s*height\s*:/m,
            "The composer container must grow with its textarea.",
        );
    }
});

test("mobile theme styles keep message actions reachable", async () => {
    const css = await readFile(GLOBALS_CSS, "utf8");
    const hiddenMessageActions =
        /\.message-actions(?:-toggle)?\s*\{[^}]*display\s*:\s*none\s*!important/;

    assert.doesNotMatch(
        css,
        hiddenMessageActions,
        "Reply, edit, reaction, and removal controls must remain reachable on mobile.",
    );
});
