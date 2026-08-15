import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const TOKENS_STYLES = new URL("../app/styles/_tokens.scss", import.meta.url);
const WCAG_AA_NORMAL_TEXT_RATIO = 4.5;

function relativeLuminance(hexColor: string): number {
    const channels = hexColor
        .slice(1)
        .match(/../g)
        ?.map((channel) => Number.parseInt(channel, 16) / 255);

    assert.equal(channels?.length, 3, `Expected a six-digit hex color, received ${hexColor}.`);

    const [red, green, blue] = channels ?? [];
    const linearize = (channel: number) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

    return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

function contrastRatio(foreground: string, background: string): number {
    const foregroundLuminance = relativeLuminance(foreground);
    const backgroundLuminance = relativeLuminance(background);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);

    return (lighter + 0.05) / (darker + 0.05);
}

test("paper muted ink meets WCAG AA against every paper surface", async () => {
    const source = await readFile(TOKENS_STYLES, "utf8");
    const paperMixin = source.match(/@mixin paper\s*\{([\s\S]*?)^\}/m)?.[1];

    assert.ok(paperMixin, "The paper mixin must define the light-theme tokens.");

    const parseToken = (tokenName: string): string => {
        const value = paperMixin.match(
            new RegExp(`^\\s*--${tokenName}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "m"),
        )?.[1];

        assert.ok(value, `The paper mixin must define --${tokenName} as a six-digit hex color.`);

        return value;
    };

    const mutedInk = parseToken("ink-muted");

    for (const surface of ["paper", "paper-raised", "paper-deep"]) {
        const ratio = contrastRatio(mutedInk, parseToken(surface));

        assert.ok(
            ratio >= WCAG_AA_NORMAL_TEXT_RATIO,
            `--ink-muted must have at least ${WCAG_AA_NORMAL_TEXT_RATIO}:1 contrast against --${surface}; received ${ratio.toFixed(2)}:1.`,
        );
    }
});
