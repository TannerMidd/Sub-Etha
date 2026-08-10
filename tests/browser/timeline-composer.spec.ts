import { expect, test, type Locator, type Page } from "@playwright/test";

const PREVIEW_URL = "/?design-preview#/room/signal-watch";
const STRESS_PREVIEW_URL = "/?design-preview&ux-preview=timeline-stress#/room/signal-watch";
const FAILURE_PREVIEW_URL =
    "/?design-preview&ux-preview=timeline-stress-failure#/room/signal-watch";

interface TextareaMetrics {
    height: number;
    scrollHeight: number;
    clientHeight: number;
    overflowY: string;
}

async function openPreview(page: Page, url = PREVIEW_URL): Promise<void> {
    await page.goto(url);
    await expect(page.locator("#message-composer")).toBeVisible();
    await expect(page.locator('[data-ui="timeline"]')).toBeVisible();

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

async function wheelTimeline(scroller: Locator, deltaY: number): Promise<void> {
    const bounds = await scroller.boundingBox();

    expect(bounds).not.toBeNull();
    await scroller
        .page()
        .mouse.move(
            (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2,
            (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2,
        );
    await scroller.page().mouse.wheel(0, deltaY);
    await scroller.page().evaluate(
        () =>
            new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            }),
    );
}

async function scrollTimelineTo(scroller: Locator, position: "top" | "bottom"): Promise<void> {
    const direction = position === "top" ? -1 : 1;

    for (let attempt = 0; attempt < 60; attempt += 1) {
        const reached = await scroller.evaluate((element, nextPosition) => {
            const threshold = nextPosition === "top" ? 2 : 14;

            return nextPosition === "top"
                ? element.scrollTop <= threshold
                : element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
        }, position);

        if (reached) {
            return;
        }

        await wheelTimeline(scroller, direction * 2_000);
        await scroller.page().waitForTimeout(20);
    }

    await expect
        .poll(() =>
            scroller.evaluate((element, nextPosition) => {
                const threshold = nextPosition === "top" ? 2 : 14;

                return nextPosition === "top"
                    ? element.scrollTop <= threshold
                    : element.scrollHeight - element.clientHeight - element.scrollTop <= threshold;
            }, position),
        )
        .toBe(true);
}

async function visibleEventAnchor(scroller: Locator): Promise<{ id: string; top: number }> {
    return scroller.evaluate((element) => {
        const scrollerBounds = element.getBoundingClientRect();
        const candidates = [...element.querySelectorAll<HTMLElement>("[data-event-id]")]
            .map((row) => {
                const bounds = row.getBoundingClientRect();

                return {
                    id: row.dataset.eventId ?? "",
                    top: bounds.top,
                    bottom: bounds.bottom,
                };
            })
            .filter(
                (row) =>
                    row.id && row.bottom > scrollerBounds.top && row.top < scrollerBounds.bottom,
            )
            .sort((left, right) => left.top - right.top);

        if (!candidates[0]) {
            throw new Error("No visible timeline event could be used as an anchor.");
        }

        return candidates[0];
    });
}

async function expectNewestMessageClearOfComposer(page: Page, eventId: string): Promise<void> {
    await expect
        .poll(async () => {
            const row = await page.locator(`[data-event-id="${eventId}"]`).boundingBox();
            const scroller = await page.locator('[data-virtuoso-scroller="true"]').boundingBox();

            if (!row || !scroller) {
                return Number.POSITIVE_INFINITY;
            }

            return row.y + row.height - (scroller.y + scroller.height - 12);
        })
        .toBeLessThanOrEqual(0);
}

async function openMessageActions(row: Locator): Promise<void> {
    await row.evaluate(
        () =>
            new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            }),
    );

    const toggle = row.locator('[data-ui="message-actions-toggle"]');

    if (await toggle.isVisible()) {
        await toggle.click();
        await expect(row).toHaveAttribute("data-actions-state", "open");
    } else {
        await row.hover();
    }

    const reply = row.getByRole("button", { name: "Reply" });

    try {
        await expect
            .poll(() =>
                reply.evaluate((button) => {
                    const bounds = button.getBoundingClientRect();
                    const hit = document.elementFromPoint(
                        bounds.left + bounds.width / 2,
                        bounds.top + bounds.height / 2,
                    );

                    return hit === button || button.contains(hit);
                }),
            )
            .toBe(true);
    } catch (cause) {
        const diagnostics = await reply.evaluate((button) => {
            const actions = button.closest<HTMLElement>('[data-ui="message-actions"]');
            const messageRow = button.closest<HTMLElement>('[data-ui="message-row"]');
            const bounds = button.getBoundingClientRect();
            const hit = document.elementFromPoint(
                bounds.left + bounds.width / 2,
                bounds.top + bounds.height / 2,
            );

            return {
                actionsBounds: actions?.getBoundingClientRect().toJSON(),
                actionsStyle: actions
                    ? {
                          display: getComputedStyle(actions).display,
                          opacity: getComputedStyle(actions).opacity,
                          pointerEvents: getComputedStyle(actions).pointerEvents,
                          position: getComputedStyle(actions).position,
                          zIndex: getComputedStyle(actions).zIndex,
                      }
                    : null,
                hit: hit?.outerHTML.slice(0, 180),
                replyBounds: bounds.toJSON(),
                rowBounds: messageRow?.getBoundingClientRect().toJSON(),
                rowClass: messageRow?.className,
                rowPaddingTop: messageRow ? getComputedStyle(messageRow).paddingTop : null,
            };
        });

        throw new Error(`Message actions never became reachable: ${JSON.stringify(diagnostics)}`, {
            cause,
        });
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
        await openPreview(page);
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
            origin: new URL(page.url()).origin,
        });

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
        expect(
            (await page.locator('[data-ui="timeline"]').boundingBox())?.height ?? 0,
        ).toBeGreaterThan(100);

        await textarea.fill("");
        const cleared = await textareaMetrics(textarea);

        expect(Math.abs(cleared.height - oneLine.height)).toBeLessThanOrEqual(1);
        expect(cleared.overflowY).toBe("hidden");
    });

    test("keeps the newest row clear while attached and preserves a detached anchor", async ({
        page,
    }) => {
        await openPreview(page, STRESS_PREVIEW_URL);

        const timeline = page.locator('[data-ui="timeline"]');
        const scroller = page.locator('[data-virtuoso-scroller="true"]');
        const textarea = page.locator("#message-composer");

        await expect(timeline).toHaveAttribute("data-item-count", "121");
        await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
        await expect(page.locator('[data-event-id="stress-remote-append"]')).toBeVisible();
        await textarea.fill(
            Array.from({ length: 8 }, (_, index) => `Line ${index + 1}`).join("\n"),
        );
        await expectNewestMessageClearOfComposer(page, "stress-remote-append");

        await wheelTimeline(scroller, -1_800);
        await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");
        const before = await visibleEventAnchor(scroller);

        await textarea.fill("One line");
        await page.waitForTimeout(300);
        const after = await waitForMessageTop(page, before.id);

        expect(Math.abs(after - before.top)).toBeLessThanOrEqual(2);
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

test("rapid real scrolling never swaps messages for seek skeletons or reattaches", async ({
    page,
}) => {
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    await page.evaluate(() => {
        const root = document.querySelector('[data-ui="timeline"]');

        if (!root) {
            throw new Error("Timeline root is missing.");
        }

        (window as typeof window & { __timelineSkeletonsSeen?: number }).__timelineSkeletonsSeen =
            root.querySelectorAll(".timeline-scroll-seek").length;
        new MutationObserver(() => {
            const skeletons = root.querySelectorAll(".timeline-scroll-seek").length;
            const testWindow = window as typeof window & { __timelineSkeletonsSeen?: number };

            testWindow.__timelineSkeletonsSeen = Math.max(
                testWindow.__timelineSkeletonsSeen ?? 0,
                skeletons,
            );
        }).observe(root, { childList: true, subtree: true });
    });

    for (let pass = 0; pass < 8; pass += 1) {
        await wheelTimeline(scroller, pass % 2 === 0 ? -2_400 : 1_800);
    }

    await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");
    expect(
        await page.evaluate(
            () =>
                (window as typeof window & { __timelineSkeletonsSeen?: number })
                    .__timelineSkeletonsSeen ?? 0,
        ),
    ).toBe(0);
});

test("twenty asynchronous message updates preserve a detached reading anchor", async ({ page }) => {
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");

    for (let attempt = 0; attempt < 4; attempt += 1) {
        await wheelTimeline(scroller, -1_200);

        if ((await timeline.getAttribute("data-scroll-mode")) === "detached") {
            break;
        }
    }

    await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");
    const before = await visibleEventAnchor(scroller);

    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as typeof window & { __previewTimelineMutationCount?: number })
                        .__previewTimelineMutationCount ?? 0,
            ),
        )
        .toBe(20);
    await expect(timeline).toHaveAttribute("data-item-count", "121");
    const after = await waitForMessageTop(page, before.id);

    expect(
        Math.abs(after - before.top),
        `async updates moved ${before.id} from ${before.top}px to ${after}px`,
    ).toBeLessThanOrEqual(2);
    await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");
});

test("failed history loading exposes retry without concurrent pagination", async ({ page }) => {
    await openPreview(page, FAILURE_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    await scrollTimelineTo(scroller, "top");
    await expect(page.getByRole("alert")).toContainText(
        "The earlier transmission index could not be reached",
    );
    await expect(timeline).toHaveAttribute("data-pagination-state", "idle");
    await expect(timeline).toHaveAttribute("data-first-item-index", "1000000");
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as typeof window & { __previewPaginationRequests?: number })
                        .__previewPaginationRequests ?? 0,
            ),
        )
        .toBe(1);

    const anchorBefore = await visibleEventAnchor(scroller);
    const retry = page.getByRole("button", { name: "Load earlier transmissions" });

    await retry.evaluate((button) => {
        const retryButton = button as HTMLButtonElement;

        retryButton.click();
        retryButton.click();
        retryButton.click();
    });
    await expect(timeline).toHaveAttribute("data-first-item-index", "999960");
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as typeof window & { __previewPaginationRequests?: number })
                        .__previewPaginationRequests ?? 0,
            ),
        )
        .toBe(2);
    await page.waitForTimeout(300);
    const anchorAfter = await waitForMessageTop(page, anchorBefore.id);

    expect(Math.abs(anchorAfter - anchorBefore.top)).toBeLessThanOrEqual(2);
});

test("top pagination preserves the reading anchor, exhausts history, and keeps the newest message reachable", async ({
    page,
}) => {
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
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

    expect(
        Math.abs(anchorAfter - anchorBefore),
        `history anchor moved from ${anchorBefore}px to ${anchorAfter}px`,
    ).toBeLessThanOrEqual(2);

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
    await expectNewestMessageClearOfComposer(page, "stress-remote-append");
});
