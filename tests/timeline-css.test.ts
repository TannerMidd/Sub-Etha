import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TIMELINE_STYLES = new URL("../app/styles/Timeline.module.scss", import.meta.url);
const COMPOSER_STYLES = new URL("../app/styles/Composer.module.scss", import.meta.url);
const GLOBAL_STYLES = new URL("../app/styles/globals.scss", import.meta.url);

test("timeline styles leave Virtuoso spacer geometry untouched", async () => {
    const css = await readFile(TIMELINE_STYLES, "utf8");
    const virtuosoInternalSelector = /\.timeline\s*>\s*div\s*>\s*div\s*>\s*div(?:[^,{]*)?\s*\{/;

    assert.doesNotMatch(
        css,
        virtuosoInternalSelector,
        "Style message elements through their own classes; Virtuoso owns its nested spacer padding and transforms.",
    );
});

test("timeline history controls remain available through stable hooks", async () => {
    const [timelineCss, globalCss] = await Promise.all([
        readFile(TIMELINE_STYLES, "utf8"),
        readFile(GLOBAL_STYLES, "utf8"),
    ]);
    const hiddenHistoryLoader = /\.history-loader\s*\{[^}]*display\s*:\s*none/;

    assert.doesNotMatch(
        timelineCss,
        hiddenHistoryLoader,
        "Earlier-history controls must not be hidden by theme overrides.",
    );
    assert.match(
        globalCss,
        /\[data-ui=["']timeline["']\] \[role=["']status["']\] > span/,
        "Decorative history copy should be styled through stable data and role hooks.",
    );
});

test("composer theme styles preserve the autosize contract", async () => {
    const css = await readFile(COMPOSER_STYLES, "utf8");
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

test("typing presence reserves space without animating timeline geometry", async () => {
    const css = await readFile(TIMELINE_STYLES, "utf8");
    const baseRule = css.match(/\.typing-line\s*\{([^}]*)\}/)?.[1] ?? "";
    const activeRule = css.match(/\.typing-line\.is-active\s*\{([^}]*)\}/)?.[1] ?? "";

    assert.match(baseRule, /min-height\s*:\s*28px/);
    assert.match(baseRule, /flex\s*:\s*0\s+0\s+28px/);
    assert.doesNotMatch(baseRule, /transition\s*:[^;]*(?:flex-basis|min-height)/);
    assert.doesNotMatch(activeRule, /(?:min-height|flex-basis)\s*:/);
});

test("mobile theme styles keep quick actions directly reachable", async () => {
    const css = await readFile(TIMELINE_STYLES, "utf8");
    const hiddenMessageActions =
        /\.message-actions(?:-toggle)?\s*\{[^}]*display\s*:\s*none\s*!important/;

    assert.doesNotMatch(
        css,
        hiddenMessageActions,
        "Reply, edit, reaction, and removal controls must remain reachable on mobile.",
    );
    assert.match(
        css,
        /\.message-actions\s*\{[^}]*grid-column\s*:\s*2[^}]*display\s*:\s*flex[^}]*opacity\s*:\s*1[^}]*pointer-events\s*:\s*auto/,
        "The mobile quick-action strip must stay visible and interactive.",
    );
    assert.match(
        css,
        /\.message-row\.is-actions-open \.message-actions-overflow\s*\{[^}]*display\s*:\s*flex/,
        "The explicit mobile overflow state must reveal secondary actions.",
    );
});
