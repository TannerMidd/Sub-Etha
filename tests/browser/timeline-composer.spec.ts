import { expect, test, type Locator, type Page } from "@playwright/test";

const PREVIEW_URL = "/?design-preview#/room/signal-watch";
const STRESS_PREVIEW_URL = "/?design-preview&ux-preview=timeline-stress#/room/signal-watch";

interface TextareaMetrics {
    height: number;
    scrollHeight: number;
    clientHeight: number;
    overflowY: string;
}

async function openPreview(page: Page, url = PREVIEW_URL): Promise<void> {
    await page.goto(url);
    await expect(page.locator("#message-composer")).toBeVisible();
    await expect(page.locator(".timeline")).toBeVisible();

    const developmentOverlay = page.getByRole("dialog", { name: "Unhandled Script Error" });

    if (await developmentOverlay.isVisible()) {
        await developmentOverlay.getByRole("button", { name: "Dismiss" }).click();
    }
}

async function textareaMetrics(textarea: Locator): Promise<TextareaMetrics> {
    return textarea.evaluate((element) => {
        const input = element as HTMLTextAreaElement;

        return {
            height: input.getBoundingClientRect().height,
            scrollHeight: input.scrollHeight,
            clientHeight: input.clientHeight,
            overflowY: getComputedStyle(input).overflowY,
        };
    });
}

async function scrollTimelineTo(scroller: Locator, position: "top" | "bottom"): Promise<void> {
    await scroller.evaluate((element, nextPosition) => {
        if (nextPosition === "top") {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Home" }));
            element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
            element.dispatchEvent(
                new PointerEvent("pointerdown", {
                    bubbles: true,
                    clientY: 100,
                    pointerId: 1,
                    pointerType: "touch",
                }),
            );
            element.dispatchEvent(
                new PointerEvent("pointermove", {
                    bubbles: true,
                    clientY: 120,
                    pointerId: 1,
                    pointerType: "touch",
                }),
            );
            element.dispatchEvent(
                new PointerEvent("pointerup", {
                    bubbles: true,
                    clientY: 120,
                    pointerId: 1,
                    pointerType: "touch",
                }),
            );
        }

        element.scrollTop = nextPosition === "top" ? 0 : element.scrollHeight;
        element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, position);
}

async function openMessageActions(row: Locator): Promise<void> {
    const toggle = row.locator(".message-actions-toggle");

    if (await toggle.isVisible()) {
        await toggle.click();
    } else {
        await row.hover();
    }
}

async function waitForMessageTop(page: Page, eventId: string): Promise<number> {
    const handle = await page.waitForFunction(
        (nextEventId) => {
            const element = [...document.querySelectorAll<HTMLElement>("[data-event-id]")].find(
                (candidate) => candidate.dataset.eventId === nextEventId,
            );

            return element ? element.getBoundingClientRect().y : false;
        },
        eventId,
        { polling: "raf", timeout: 8_000 },
    );

    return Number(await handle.jsonValue());
}

test.describe("composer regression coverage", () => {
    test("grows through multiple lines, caps, scrolls internally, and collapses", async ({
        context,
        page,
    }) => {
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: "http://localhost:4173",
        });
        await openPreview(page);

        const textarea = page.locator("#message-composer");
        const status = page.locator('footer[aria-label="Receiver status"]');

        await textarea.fill("One line");
        const oneLine = await textareaMetrics(textarea);

        const fourLines = ["Alpha", "Beta", "Gamma", "Delta"].join("\n");

        await textarea.fill("");
        await page.evaluate(async (value) => navigator.clipboard.writeText(value), fourLines);
        await textarea.press("Control+V");
        await expect(textarea).toHaveValue(fourLines);
        const fourLine = await textareaMetrics(textarea);
        const viewport = page.viewportSize();

        expect(viewport).not.toBeNull();
        await page.setViewportSize({
            width: Math.max(320, (viewport?.width ?? 390) - 24),
            height: Math.max(700, (viewport?.height ?? 844) - 24),
        });
        await expect(textarea).toHaveValue(fourLines);
        expect((await textareaMetrics(textarea)).height).toBeGreaterThan(oneLine.height + 10);

        if (viewport) {
            await page.setViewportSize(viewport);
        }

        await textarea.fill(
            Array.from({ length: 8 }, (_, index) => `Line ${index + 1}`).join("\n"),
        );
        const capped = await textareaMetrics(textarea);

        expect(fourLine.height).toBeGreaterThan(oneLine.height + 10);
        expect(capped.height).toBeGreaterThanOrEqual(fourLine.height);
        expect(capped.height).toBeLessThanOrEqual(161);
        expect(capped.scrollHeight).toBeGreaterThan(capped.clientHeight);
        expect(capped.overflowY).toBe("auto");
        await expect(status).toBeVisible();
        expect((await page.locator(".timeline").boundingBox())?.height ?? 0).toBeGreaterThan(100);

        await textarea.fill("");
        const cleared = await textareaMetrics(textarea);

        expect(Math.abs(cleared.height - oneLine.height)).toBeLessThanOrEqual(1);
        expect(cleared.overflowY).toBe("hidden");
    });

    test("reply, edit cancellation, and send preserve composer sizing", async ({ page }) => {
        await openPreview(page);

        const textarea = page.locator("#message-composer");
        const replyRow = page.locator('[data-event-id="m8"]');

        await replyRow.scrollIntoViewIfNeeded();
        await openMessageActions(replyRow);
        await replyRow.getByRole("button", { name: "Reply" }).click();
        await expect(page.getByText("Replying to Tamsin")).toBeVisible();
        await textarea.fill("Reply line one\nReply line two\nReply line three\nReply line four");
        expect((await textareaMetrics(textarea)).height).toBeGreaterThan(50);
        await page.getByRole("button", { name: "Cancel reply" }).click();
        await expect(page.getByText("Replying to Tamsin")).toBeHidden();

        await textarea.fill("");
        const ownRow = page.locator('[data-event-id="m5"]');

        await ownRow.scrollIntoViewIfNeeded();
        await openMessageActions(ownRow);
        await ownRow.getByRole("button", { name: "Edit" }).click();
        await expect(page.getByText("Editing message")).toBeVisible();
        await textarea.fill("Edit one\nEdit two\nEdit three\nEdit four");
        expect((await textareaMetrics(textarea)).height).toBeGreaterThan(50);
        await page.getByRole("button", { name: "Cancel message edit" }).click();
        await expect(page.getByText("Editing message")).toBeHidden();

        const resetHeight = (await textareaMetrics(textarea)).height;

        await textarea.fill("Send one\nSend two\nSend three\nSend four");
        expect((await textareaMetrics(textarea)).height).toBeGreaterThan(resetHeight + 10);
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(textarea).toHaveValue("");
        expect(
            Math.abs((await textareaMetrics(textarea)).height - resetHeight),
        ).toBeLessThanOrEqual(1);
    });
});

test("top pagination preserves the reading anchor, exhausts history, and keeps the newest message reachable", async ({
    page,
}) => {
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator(".timeline");
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    await expect(page.locator('[data-event-id="stress-remote-append"]')).toBeVisible();
    await page.waitForTimeout(100);
    await expect(timeline).toHaveAttribute("data-first-item-index", "1000000");
    await expect(page.getByRole("button", { name: "Load earlier transmissions" })).toBeAttached();
    await scrollTimelineTo(scroller, "top");
    const anchorBefore = await waitForMessageTop(page, "stress-80");

    await expect(timeline).toHaveAttribute("data-first-item-index", "999960");
    await expect(timeline).toHaveAttribute("data-item-count", "161");
    await page.waitForTimeout(500);
    const anchorAfter = await waitForMessageTop(page, "stress-80");

    expect(Math.abs(anchorAfter - anchorBefore)).toBeLessThanOrEqual(2);

    await scrollTimelineTo(scroller, "top");
    await expect(timeline).toHaveAttribute("data-first-item-index", "999920");
    await expect(timeline).toHaveAttribute("data-item-count", "201");
    await expect(timeline).toHaveAttribute("data-has-more-history", "false");
    await expect(page.getByText("Beginning of recorded transmissions")).toBeAttached();
    await scrollTimelineTo(scroller, "top");
    await expect(page.locator('[data-event-id="stress-0"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Load earlier transmissions" })).toHaveCount(0);

    await scrollTimelineTo(scroller, "top");
    await page.waitForTimeout(400);
    await expect(timeline).toHaveAttribute("data-first-item-index", "999920");
    await expect(timeline).toHaveAttribute("data-item-count", "201");

    await scrollTimelineTo(scroller, "bottom");
    await expect(page.locator('[data-event-id="stress-remote-append"]')).toBeVisible();
});
