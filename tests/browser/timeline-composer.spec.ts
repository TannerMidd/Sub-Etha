import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const PREVIEW_URL = "/?design-preview#/room/signal-watch";
const STRESS_PREVIEW_URL = "/?design-preview&ux-preview=timeline-stress#/room/signal-watch";
const FAILURE_PREVIEW_URL =
    "/?design-preview&ux-preview=timeline-stress-failure#/room/signal-watch";
// The fixed 28px typing-presence reserve separates the timeline scroller from
// the composer in the Zen layout, so the last row only needs to clear the
// scroller edge itself.
const MESSAGE_COMPOSER_CLEARANCE_PX = 0;
const SUBPIXEL_TOLERANCE_PX = 0.5;
const DETACHED_SCROLL_MARGIN_PX = 32;
const DIRECT_SCROLL_DISTANCE_PX = 240;
// Virtuoso publishes at-bottom changes through a deliberate 50ms throttle;
// four animation frames covers that public callback plus the React commit.
const DIRECT_SCROLL_FRAME_BUDGET = 4;
const PREPEND_ANCHOR_TOLERANCE_PX = 4;
const MAX_VISIBLE_FRAME_JERK_PX = 8;

interface TextareaMetrics {
    height: number;
    scrollHeight: number;
    clientHeight: number;
    overflowY: string;
}

interface TimelineMotionSample {
    rowTop: number | null;
    stageHeight: number | null;
    typingHeight: number | null;
}

interface TimelineGeometrySample {
    mode: string | null;
    paginationState: string | null;
    firstItemIndex: number | null;
    scrollTop: number;
    bottomDistance: number;
    rowTops: Record<string, number>;
}

async function startTimelineMotionProbe(page: Page, eventId: string): Promise<string> {
    const key = `${eventId}-${Date.now()}-${Math.random()}`;

    await page.evaluate(
        ({ nextEventId, probeKey }) => {
            type MotionProbe = {
                frame: number;
                timer: number | null;
                samples: TimelineMotionSample[];
            };
            const probeWindow = window as typeof window & {
                __timelineMotionProbes?: Record<string, MotionProbe>;
            };
            const probes = (probeWindow.__timelineMotionProbes ??= {});
            const probe: MotionProbe = { frame: 0, timer: null, samples: [] };

            const record = () => {
                const row = document.querySelector<HTMLElement>(
                    `[data-event-id="${CSS.escape(nextEventId)}"]`,
                );
                const stage = document.querySelector<HTMLElement>('[data-ui="conversation-stage"]');
                const typing = document.querySelector<HTMLElement>('[data-ui="typing-line"]');

                probe.samples.push({
                    rowTop: row?.getBoundingClientRect().top ?? null,
                    stageHeight: stage?.getBoundingClientRect().height ?? null,
                    typingHeight: typing?.getBoundingClientRect().height ?? null,
                });
            };

            const schedule = () => {
                probe.frame = window.requestAnimationFrame(() => {
                    probe.timer = window.setTimeout(() => {
                        record();
                        schedule();
                    }, 0);
                });
            };

            probes[probeKey] = probe;
            record();
            schedule();
        },
        { nextEventId: eventId, probeKey: key },
    );

    return key;
}

async function stopTimelineMotionProbe(page: Page, key: string): Promise<TimelineMotionSample[]> {
    return page.evaluate((probeKey) => {
        type MotionProbe = {
            frame: number;
            timer: number | null;
            samples: TimelineMotionSample[];
        };
        const probeWindow = window as typeof window & {
            __timelineMotionProbes?: Record<string, MotionProbe>;
        };
        const probe = probeWindow.__timelineMotionProbes?.[probeKey];

        if (!probe) {
            return [];
        }

        window.cancelAnimationFrame(probe.frame);

        if (probe.timer !== null) {
            window.clearTimeout(probe.timer);
        }

        delete probeWindow.__timelineMotionProbes?.[probeKey];

        return probe.samples;
    }, key);
}

function motionExcursion(samples: TimelineMotionSample[], key: keyof TimelineMotionSample): number {
    const values = samples
        .map((sample) => sample[key])
        .filter((value): value is number => value !== null);

    return values.length ? Math.max(...values) - Math.min(...values) : Number.POSITIVE_INFINITY;
}

async function startTimelineGeometryProbe(page: Page): Promise<string> {
    const key = `geometry-${Date.now()}-${Math.random()}`;

    await page.evaluate((probeKey) => {
        type GeometryProbe = {
            frame: number;
            samples: TimelineGeometrySample[];
        };
        const probeWindow = window as typeof window & {
            __timelineGeometryProbes?: Record<string, GeometryProbe>;
        };
        const probes = (probeWindow.__timelineGeometryProbes ??= {});
        const probe: GeometryProbe = { frame: 0, samples: [] };

        const record = () => {
            const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
            const timeline = document.querySelector<HTMLElement>('[data-ui="timeline"]');

            if (scroller) {
                const rowTops: Record<string, number> = {};

                for (const row of scroller.querySelectorAll<HTMLElement>("[data-event-id]")) {
                    const id = row.dataset.eventId;

                    if (id) {
                        rowTops[id] = row.getBoundingClientRect().top;
                    }
                }

                probe.samples.push({
                    mode: timeline?.dataset.scrollMode ?? null,
                    paginationState: timeline?.dataset.paginationState ?? null,
                    firstItemIndex: timeline?.dataset.firstItemIndex
                        ? Number.parseInt(timeline.dataset.firstItemIndex, 10)
                        : null,
                    scrollTop: scroller.scrollTop,
                    bottomDistance:
                        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
                    rowTops,
                });
            }

            probe.frame = window.requestAnimationFrame(record);
        };

        probes[probeKey] = probe;
        record();
    }, key);

    return key;
}

async function stopTimelineGeometryProbe(
    page: Page,
    key: string,
): Promise<TimelineGeometrySample[]> {
    return page.evaluate((probeKey) => {
        type GeometryProbe = {
            frame: number;
            samples: TimelineGeometrySample[];
        };
        const probeWindow = window as typeof window & {
            __timelineGeometryProbes?: Record<string, GeometryProbe>;
        };
        const probe = probeWindow.__timelineGeometryProbes?.[probeKey];

        if (!probe) {
            return [];
        }

        window.cancelAnimationFrame(probe.frame);
        delete probeWindow.__timelineGeometryProbes?.[probeKey];

        return probe.samples;
    }, key);
}

function maxCommonRowFrameDelta(samples: TimelineGeometrySample[]): number {
    let maximum = 0;

    for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex += 1) {
        const previous = samples[sampleIndex - 1]?.rowTops ?? {};
        const current = samples[sampleIndex]?.rowTops ?? {};

        for (const [id, top] of Object.entries(current)) {
            const previousTop = previous[id];

            if (previousTop !== undefined) {
                maximum = Math.max(maximum, Math.abs(top - previousTop));
            }
        }
    }

    return maximum;
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
    const threshold = position === "top" ? 2 : SUBPIXEL_TOLERANCE_PX;

    for (let attempt = 0; attempt < 60; attempt += 1) {
        const reached = await scroller.evaluate(
            (element, options) =>
                options.position === "top"
                    ? element.scrollTop <= options.threshold
                    : element.scrollHeight - element.clientHeight - element.scrollTop <=
                      options.threshold,
            { position, threshold },
        );

        if (reached) {
            return;
        }

        await wheelTimeline(scroller, direction * 2_000);
        await scroller.page().waitForTimeout(20);
    }

    await expect
        .poll(() =>
            scroller.evaluate(
                (element, options) =>
                    options.position === "top"
                        ? element.scrollTop <= options.threshold
                        : element.scrollHeight - element.clientHeight - element.scrollTop <=
                          options.threshold,
                { position, threshold },
            ),
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

            return (
                row.y + row.height - (scroller.y + scroller.height - MESSAGE_COMPOSER_CLEARANCE_PX)
            );
        })
        .toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX);
}

async function openMessageActions(row: Locator, actionName = "Reply"): Promise<void> {
    await row.evaluate(
        () =>
            new Promise<void>((resolve) => {
                window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
            }),
    );

    const action = row.getByRole("button", { name: actionName, includeHidden: true });
    const reachable = await action.evaluate((button) => {
        const bounds = button.getBoundingClientRect();

        if (!bounds.width || !bounds.height || getComputedStyle(button).pointerEvents === "none") {
            return false;
        }

        const hit = document.elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
        );

        return hit === button || button.contains(hit);
    });

    if (!reachable) {
        await row.hover();
    }

    try {
        await expect
            .poll(() =>
                action.evaluate((button) => {
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
        const diagnostics = await action.evaluate((button) => {
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

        throw new Error(`${actionName} never became reachable: ${JSON.stringify(diagnostics)}`, {
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

            return element ? { top: element.getBoundingClientRect().y } : null;
        },
        eventId,
        { polling: "raf", timeout: 8_000 },
    );
    const result = (await handle.jsonValue()) as { top: number };

    return result.top;
}

test.describe("composer regression coverage", () => {
    test("mobile text and selection stay clear of composer controls", async ({
        page,
    }, testInfo) => {
        test.skip(testInfo.project.name !== "mobile-390", "Mobile layout coverage only.");
        await openPreview(page);

        const textarea = page.locator("#message-composer");
        const attachment = page.getByRole("button", { name: "Attach a file" });
        const emoji = page.getByRole("button", { name: "Choose an emoji" });
        const emojiControl = emoji.locator("..");
        const send = page.getByRole("button", { name: "Send message" });

        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            const nearWrap =
                width === 390 ? "Draft reaches the control edge" : "Draft reaches edge";
            const draft = `${nearWrap}\nSelection remains inside the editable message.`;

            await textarea.fill("");
            await textarea.evaluate((element) => element.blur());

            await expect(emojiControl).toHaveCSS("opacity", "0");
            await expect(emojiControl).toHaveCSS("pointer-events", "none");

            const singleLineBox = await textarea.boundingBox();

            expect(singleLineBox).not.toBeNull();
            expect(singleLineBox?.height ?? 0).toBeGreaterThanOrEqual(44);

            for (const yRatio of [0.1, 0.5, 0.9]) {
                const x = (singleLineBox?.x ?? 0) + (singleLineBox?.width ?? 0) / 2;
                const y = (singleLineBox?.y ?? 0) + (singleLineBox?.height ?? 0) * yRatio;

                await page.touchscreen.tap(x, y);
                await expect(textarea).toBeFocused();
                await expect(emojiControl).toHaveCSS("opacity", "1");
                await expect(emojiControl).toHaveCSS("pointer-events", "auto");
                await textarea.evaluate((element) => element.blur());
                await expect(emojiControl).toHaveCSS("opacity", "0");
            }

            await textarea.fill(nearWrap);
            await expect(textarea).toHaveValue(nearWrap);
            await textarea.fill(draft);

            const [textareaBox, attachmentBox, emojiBox, sendBox] = await Promise.all([
                textarea.boundingBox(),
                attachment.boundingBox(),
                emoji.boundingBox(),
                send.boundingBox(),
            ]);

            expect(textareaBox).not.toBeNull();
            expect(attachmentBox).not.toBeNull();
            expect(emojiBox).not.toBeNull();
            expect(sendBox).not.toBeNull();

            const textareaLeft = textareaBox?.x ?? 0;
            const textareaRight = textareaLeft + (textareaBox?.width ?? 0);

            expect((attachmentBox?.x ?? 0) + (attachmentBox?.width ?? 0)).toBeLessThanOrEqual(
                textareaLeft,
            );
            expect(textareaRight).toBeLessThanOrEqual(emojiBox?.x ?? 0);
            expect(textareaRight).toBeLessThanOrEqual(sendBox?.x ?? 0);

            const hitTargets = await textarea.evaluate((element) => {
                const input = element as HTMLTextAreaElement;
                const bounds = input.getBoundingClientRect();
                const points = [
                    [bounds.left + 1, bounds.top + 1],
                    [bounds.right - 1, bounds.top + 1],
                    [bounds.left + 1, bounds.top + bounds.height / 2],
                    [bounds.right - 1, bounds.top + bounds.height / 2],
                    [bounds.left + 1, bounds.bottom - 1],
                    [bounds.right - 1, bounds.bottom - 1],
                ];

                return points.map(([x, y]) => {
                    const target = document.elementFromPoint(x, y);

                    return target === input || target?.closest("#message-composer") === input;
                });
            });

            expect(hitTargets).toEqual([true, true, true, true, true, true]);

            await textarea.evaluate((element) => {
                const input = element as HTMLTextAreaElement;

                input.focus();
                input.setSelectionRange(2, input.value.length - 2);
                input.dispatchEvent(new Event("select", { bubbles: true }));
            });

            const selection = await textarea.evaluate((element) => {
                const input = element as HTMLTextAreaElement;

                return {
                    active: document.activeElement === input,
                    start: input.selectionStart,
                    end: input.selectionEnd,
                    documentSelection: window.getSelection()?.toString() ?? "",
                };
            });

            expect(selection).toEqual({
                active: true,
                start: 2,
                end: draft.length - 2,
                documentSelection: draft.slice(2, -2),
            });
            await expect(emoji).toHaveAttribute("aria-expanded", "false");
            await expect(textarea).toHaveValue(draft);
        }
    });

    test("mobile messages expose one-tap reply and reaction actions", async ({
        page,
    }, testInfo) => {
        test.skip(testInfo.project.name !== "mobile-390", "Mobile layout coverage only.");
        await openPreview(page);

        const textarea = page.locator("#message-composer");

        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            const remoteRow = page.locator('[data-event-id="m8"]');

            await remoteRow.scrollIntoViewIfNeeded();

            const content = remoteRow.locator('[data-ui="message-content"]');
            const actions = remoteRow.locator('[data-ui="message-actions"]');
            const reply = remoteRow.getByRole("button", { name: "Reply" });
            const reaction = remoteRow.getByRole("button", { name: "Add reaction" });

            await expect(reply).toBeVisible();
            await expect(reaction).toBeVisible();

            const [contentBox, actionsBox, replyBox, reactionBox] = await Promise.all([
                content.boundingBox(),
                actions.boundingBox(),
                reply.boundingBox(),
                reaction.boundingBox(),
            ]);

            expect(contentBox).not.toBeNull();
            expect(actionsBox).not.toBeNull();
            expect(replyBox?.width ?? 0).toBeGreaterThanOrEqual(44);
            expect(replyBox?.height ?? 0).toBeGreaterThanOrEqual(44);
            expect(reactionBox?.width ?? 0).toBeGreaterThanOrEqual(44);
            expect(reactionBox?.height ?? 0).toBeGreaterThanOrEqual(44);
            expect((contentBox?.y ?? 0) + (contentBox?.height ?? 0)).toBeLessThanOrEqual(
                (actionsBox?.y ?? 0) + SUBPIXEL_TOLERANCE_PX,
            );

            await reaction.click();
            await expect(
                page.getByRole("dialog", { name: "React to message from Tamsin" }),
            ).toBeVisible();
            await page.keyboard.press("Escape");
            await expect(reaction).toHaveAttribute("aria-expanded", "false");

            await textarea.fill("Mobile reply draft");
            await textarea.evaluate((element) => element.blur());
            await reply.click();
            await expect(page.getByText("Replying to Tamsin")).toBeVisible();
            await expect(textarea).toBeFocused();

            const selection = await textarea.evaluate((element) => {
                const input = element as HTMLTextAreaElement;

                return { start: input.selectionStart, end: input.selectionEnd };
            });

            expect(selection).toEqual({ start: 18, end: 18 });
            await page.getByRole("button", { name: "Cancel reply" }).click();

            const ownRow = page.locator('[data-event-id="m9"]');

            await ownRow.scrollIntoViewIfNeeded();

            const edit = ownRow.getByRole("button", { name: "Edit" });
            const remove = ownRow.getByRole("button", { name: "Remove" });

            await expect(edit).toBeVisible();
            await expect(remove).toBeVisible();

            for (const control of [edit, remove]) {
                const bounds = await control.boundingBox();

                expect(bounds?.width ?? 0).toBeGreaterThanOrEqual(44);
                expect(bounds?.height ?? 0).toBeGreaterThanOrEqual(44);
            }
        }
    });

    test("message actions never render an overflow ellipsis", async ({ page }) => {
        await openPreview(page);

        const ownRow = page.locator('[data-event-id="m9"]');

        await ownRow.scrollIntoViewIfNeeded();
        await ownRow.hover();
        await expect(page.getByRole("button", { name: /More actions/ })).toHaveCount(0);
        await expect(page.locator('[data-ui="message-actions-toggle"]')).toHaveCount(0);
        await expect(page.locator('[data-ui="message-actions-overflow"]')).toHaveCount(0);
        await expect(ownRow.getByRole("button", { name: "Reply" })).toHaveCount(1);
        await expect(ownRow.getByRole("button", { name: "Add reaction" })).toHaveCount(1);
        await expect(ownRow.getByRole("button", { name: "Edit" })).toHaveCount(1);
        await expect(ownRow.getByRole("button", { name: "Remove" })).toHaveCount(1);
    });

    test("typing presence fades without moving the timeline", async ({ page }) => {
        await openPreview(page);

        const timeline = page.locator('[data-ui="timeline"]');
        const textarea = page.locator("#message-composer");
        const typing = page.locator('[data-ui="typing-line"]');

        await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
        await expect(typing).toHaveAttribute("data-active", "false");

        const appearingProbe = await startTimelineMotionProbe(page, "m9");

        await textarea.fill("Quiet carrier note");
        await expect(typing).toHaveAttribute("data-active", "true");
        await page.waitForTimeout(250);
        const appearing = await stopTimelineMotionProbe(page, appearingProbe);

        expect(motionExcursion(appearing, "stageHeight")).toBeLessThanOrEqual(0.5);
        expect(motionExcursion(appearing, "typingHeight")).toBeLessThanOrEqual(0.5);
        expect(motionExcursion(appearing, "rowTop")).toBeLessThanOrEqual(1);

        const disappearingProbe = await startTimelineMotionProbe(page, "m9");

        await textarea.fill("");
        await expect(typing).toHaveAttribute("data-active", "false");
        await page.waitForTimeout(250);
        const disappearing = await stopTimelineMotionProbe(page, disappearingProbe);

        expect(motionExcursion(disappearing, "stageHeight")).toBeLessThanOrEqual(0.5);
        expect(motionExcursion(disappearing, "typingHeight")).toBeLessThanOrEqual(0.5);
        expect(motionExcursion(disappearing, "rowTop")).toBeLessThanOrEqual(1);
    });

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
        await expect(status).toBeAttached();
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

        await scroller.evaluate((element) => {
            element.scrollTop = Math.max(0, element.scrollTop - 1_800);
        });
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
        const ownRow = page.locator('[data-event-id="m9"]');

        await ownRow.scrollIntoViewIfNeeded();
        await openMessageActions(ownRow, "Edit");
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

test("direct scroll away from bottom detaches and ignores later geometry changes", async ({
    page,
}) => {
    test.slow();
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");

    const directScroll = await scroller.evaluate(async (element, distance) => {
        const start = element.scrollTop;
        const target = Math.max(0, start - distance);
        const samples: Array<{ scrollTop: number; mode: string | null; bottomDistance: number }> =
            [];

        // This is deliberately a direct DOM scroll position change. It
        // does not synthesize wheel, touch, pointer, or keyboard ownership.
        element.scrollTop = target;

        for (let frame = 0; frame < 8; frame += 1) {
            await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
            const timelineRoot = document.querySelector<HTMLElement>('[data-ui="timeline"]');

            samples.push({
                scrollTop: element.scrollTop,
                mode: timelineRoot?.dataset.scrollMode ?? null,
                bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
            });
        }

        return { start, target, samples };
    }, DIRECT_SCROLL_DISTANCE_PX);

    expect(directScroll.target).toBeLessThan(directScroll.start - 100);
    const changedIndex = directScroll.samples.findIndex(
        (sample) => sample.scrollTop < directScroll.start - 100,
    );

    expect(changedIndex).toBeGreaterThanOrEqual(0);
    const detachedIndex = directScroll.samples.findIndex((sample) => sample.mode === "detached");

    expect(detachedIndex).toBeGreaterThanOrEqual(0);
    expect(detachedIndex).toBeLessThanOrEqual(changedIndex + DIRECT_SCROLL_FRAME_BUDGET);
    expect(
        Math.min(
            ...directScroll.samples.slice(detachedIndex).map((sample) => sample.bottomDistance),
        ),
    ).toBeGreaterThan(DETACHED_SCROLL_MARGIN_PX);

    const mutationCountAtDetach = await page.evaluate(
        () =>
            (window as typeof window & { __previewTimelineMutationCount?: number })
                .__previewTimelineMutationCount ?? 0,
    );

    await expect
        .poll(
            () =>
                page.evaluate(
                    () =>
                        (window as typeof window & { __previewTimelineMutationCount?: number })
                            .__previewTimelineMutationCount ?? 0,
                ),
            { timeout: 4_000 },
        )
        .toBeGreaterThan(mutationCountAtDetach);
    await expect(timeline).toHaveAttribute("data-item-count", "121", { timeout: 4_000 });
    await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");

    expect(
        await scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
    ).toBeGreaterThan(DETACHED_SCROLL_MARGIN_PX);
});

test("slow fractional direct scrolling stays detached from the live edge", async ({
    page,
}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "Mobile fractional scroll regression");
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
    const samples = await page
        .locator('[data-virtuoso-scroller="true"]')
        .evaluate(async (element) => {
            let target = element.scrollTop;
            const start = target;
            const samples: Array<{
                scrollTop: number;
                mode: string | null;
                bottomDistance: number;
            }> = [];

            for (let frame = 0; frame < 160; frame += 1) {
                // Keep the target fractional across assignments. Blink rounds a
                // single subpixel scrollTop write, so repeatedly writing
                // `current - 0.4` would not move the scroller at all.
                target -= 0.4;
                element.scrollTop = Math.max(0, target);

                await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

                const timelineRoot = document.querySelector<HTMLElement>('[data-ui="timeline"]');

                samples.push({
                    scrollTop: element.scrollTop,
                    mode: timelineRoot?.dataset.scrollMode ?? null,
                    bottomDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
                });
            }

            return { start, samples };
        });

    const changedIndex = samples.samples.findIndex(
        (sample) => sample.scrollTop < samples.start - 8,
    );

    expect(changedIndex).toBeGreaterThanOrEqual(0);
    expect(samples.start - samples.samples.at(-1)!.scrollTop).toBeGreaterThanOrEqual(32);
    const detachedIndex = samples.samples.findIndex((sample) => sample.mode === "detached");

    expect(detachedIndex).toBeGreaterThanOrEqual(0);
    expect(detachedIndex).toBeLessThanOrEqual(changedIndex + DIRECT_SCROLL_FRAME_BUDGET);

    const awayIndex = samples.samples.findIndex(
        (sample) => sample.bottomDistance > DETACHED_SCROLL_MARGIN_PX,
    );

    expect(awayIndex).toBeGreaterThanOrEqual(0);
    expect(samples.samples.slice(awayIndex).some((sample) => sample.mode === "attached")).toBe(
        false,
    );
    await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");
});

/*
 * Keep this historical touch test separate from the direct-scroll regression:
 * it exercises a held contact, not post-release inertial physics.
 */
test("a held touch that reaches the physical bottom reports attached", async ({
    page,
}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "Mobile touch ownership regression");
    const session = await page.context().newCDPSession(page);

    await page.goto(STRESS_PREVIEW_URL, { waitUntil: "domcontentloaded" });

    const timeline = page.locator('[data-ui="timeline"]');
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    await scroller.waitFor({ state: "visible" });
    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
    await page.waitForTimeout(220);
    const bounds = await scroller.boundingBox();

    expect(bounds).not.toBeNull();
    const x = (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2;
    const startY = (bounds?.y ?? 0) + Math.min((bounds?.height ?? 600) * 0.35, 240);

    await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y: startY }],
    });

    for (const y of [startY + 50, startY + 100, startY + 150]) {
        await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y }],
        });
        await page.waitForTimeout(18);
    }

    await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");
    await expect
        .poll(() =>
            scroller.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
        )
        .toBeGreaterThan(40);

    const plantedIdleMs = await scroller.evaluate(async (element) => {
        let previous = element.scrollTop;
        let stableSince = performance.now();
        const started = stableSince;

        while (performance.now() - stableSince < 260 && performance.now() - started < 1_500) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 20));

            if (Math.abs(element.scrollTop - previous) > 0.5) {
                previous = element.scrollTop;
                stableSince = performance.now();
            }
        }

        return performance.now() - stableSince;
    });

    expect(plantedIdleMs).toBeGreaterThanOrEqual(240);

    for (const y of [startY + 90, startY + 30, startY - 50, startY - 140, startY - 230]) {
        await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [{ x, y }],
        });
        await page.waitForTimeout(18);
    }

    await expect
        .poll(() =>
            scroller.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
        )
        .toBeLessThanOrEqual(2);
    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");

    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
});

test("history prepend preserves its anchor and bounds visible frame jerk", async ({ page }) => {
    test.slow();
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    // Let the fixture's delayed content settle before measuring the prepend;
    // the probe should cover the firstItemIndex transition itself, not startup.
    await page.waitForTimeout(2_500);
    await expect(timeline).toHaveAttribute("data-first-item-index", "1000000");

    const geometryProbe = await startTimelineGeometryProbe(page);

    await scrollTimelineTo(scroller, "top");
    await expect(timeline).toHaveAttribute("data-pagination-state", "loading");
    const anchorBefore = await visibleEventAnchor(scroller);

    await expect(timeline).toHaveAttribute("data-first-item-index", "999960");
    await expect(timeline).toHaveAttribute("data-item-count", "161");
    await page.waitForTimeout(350);

    const samples = await stopTimelineGeometryProbe(page, geometryProbe);
    const stablePrependIndex = samples.findIndex((sample, sampleIndex) => {
        const next = samples[sampleIndex + 1];
        const anchorTop = sample.rowTops["stress-80"];
        const nextAnchorTop = next?.rowTops["stress-80"];

        return (
            sample.firstItemIndex === 999960 &&
            next?.firstItemIndex === 999960 &&
            anchorTop !== undefined &&
            nextAnchorTop !== undefined &&
            Math.abs(nextAnchorTop - anchorTop) <= MAX_VISIBLE_FRAME_JERK_PX
        );
    });

    expect(stablePrependIndex).toBeGreaterThan(0);

    const afterAnchor = samples
        .slice(stablePrependIndex, stablePrependIndex + 12)
        .map((sample) => sample.rowTops["stress-80"])
        .filter((top): top is number => top !== undefined);

    expect(afterAnchor.length).toBeGreaterThanOrEqual(2);

    const afterMedian = afterAnchor[Math.floor(afterAnchor.length / 2)] ?? 0;

    expect(
        Math.abs(afterMedian - anchorBefore.top),
        `history anchor moved from ${anchorBefore.top}px to ${afterMedian}px`,
    ).toBeLessThanOrEqual(PREPEND_ANCHOR_TOLERANCE_PX);

    // The frames before this point include the intentional wheel travel and
    // Virtuoso's logical scrollTop increase by the newly prepended height. Only
    // screen-space row motion after the preserved anchor has stabilized counts
    // as a visible jerk.
    const postCommitSamples = samples.slice(stablePrependIndex, stablePrependIndex + 10);

    expect(maxCommonRowFrameDelta(postCommitSamples)).toBeLessThanOrEqual(
        MAX_VISIBLE_FRAME_JERK_PX,
    );
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
    await page.waitForTimeout(220);
    const before = await visibleEventAnchor(scroller);
    const motionProbe = await startTimelineMotionProbe(page, before.id);

    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    (window as typeof window & { __previewTimelineMutationCount?: number })
                        .__previewTimelineMutationCount ?? 0,
            ),
        )
        .toBe(20);
    const motion = await stopTimelineMotionProbe(page, motionProbe);

    expect(motion.every((sample) => sample.rowTop !== null)).toBe(true);
    expect(motionExcursion(motion, "rowTop")).toBeLessThanOrEqual(2);
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

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
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
    await page.waitForTimeout(700);
    const anchorAfter = await waitForMessageTop(page, anchorBefore.id);

    expect(
        Math.abs(anchorAfter - anchorBefore.top),
        `retry prepend moved ${anchorBefore.id} from ${anchorBefore.top}px to ${anchorAfter}px`,
    ).toBeLessThanOrEqual(MAX_VISIBLE_FRAME_JERK_PX);
});

test("top pagination preserves the reading anchor, exhausts history, and keeps the newest message reachable", async ({
    page,
}) => {
    test.slow();
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    await expect(page.locator('[data-event-id="stress-remote-append"]')).toBeVisible();
    await page.waitForTimeout(100);
    await expect(timeline).toHaveAttribute("data-first-item-index", "1000000");
    await expect(page.getByRole("button", { name: "Load earlier transmissions" })).toBeAttached();
    await scrollTimelineTo(scroller, "top");
    await expect(timeline).toHaveAttribute("data-pagination-state", "loading");
    // Let the synthetic wheel gesture hand control back before sampling the
    // anchor that the completed history request must preserve.
    await page.waitForTimeout(300);
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

    await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");
    await expect(page.locator('[data-event-id="stress-remote-append"]')).not.toBeVisible();
    await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
    await expectNewestMessageClearOfComposer(page, "stress-remote-append");
});

test("a local send stays attached while an earlier-history request completes", async ({ page }) => {
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
    const textarea = page.locator("#message-composer");

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
    await page.getByRole("button", { name: "Load earlier transmissions" }).click();
    await expect(timeline).toHaveAttribute("data-pagination-state", "loading");
    await textarea.fill("Keep this transmission at the live edge.");
    await page.getByRole("button", { name: "Send message" }).click();

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
    await expect(timeline).toHaveAttribute("data-first-item-index", "999960");
    await expect(page.locator('[data-event-id="stress-local-1"]')).toBeVisible();
    await expectNewestMessageClearOfComposer(page, "stress-local-1");
    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
});

test("a local send reattaches after direct detachment", async ({ page }) => {
    await openPreview(page, STRESS_PREVIEW_URL);

    const timeline = page.locator('[data-ui="timeline"]');
    const scroller = page.locator('[data-virtuoso-scroller="true"]');
    const textarea = page.locator("#message-composer");

    // The direct-detach regression above owns late fixture updates. Settle them
    // here so this test isolates the local-append reattachment contract.
    await page.waitForTimeout(2_500);
    await textarea.fill("Follow this transmission after direct detachment.");
    await scroller.evaluate((element, distance) => {
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - distance);
    }, DIRECT_SCROLL_DISTANCE_PX);
    await expect(timeline).toHaveAttribute("data-scroll-mode", "detached");
    expect(
        await scroller.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
    ).toBeGreaterThan(200);

    await page.getByRole("button", { name: "Send message" }).click();

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
    await expect(page.locator('[data-event-id="stress-local-1"]')).toBeAttached();
    await expectNewestMessageClearOfComposer(page, "stress-local-1");
});

test("opening a room never reports attachment before reaching the newest message", async ({
    page,
}) => {
    // `attached` is the mode that arms `startReached` and hands position control
    // to the height-change handlers. Reporting it while the list is still parked
    // in unmeasured history paginates more history in and strands the reader far
    // above the newest message, so sample every frame of an untouched open.
    await page.addInitScript(() => {
        type OpenSample = { mode: string | null; bottomDistance: number };
        const probeWindow = window as typeof window & { __openSamples?: OpenSample[] };

        probeWindow.__openSamples = [];

        const sample = () => {
            const scroller = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');

            if (scroller) {
                probeWindow.__openSamples?.push({
                    mode:
                        document.querySelector<HTMLElement>('[data-ui="timeline"]')?.dataset
                            .scrollMode ?? null,
                    bottomDistance:
                        scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
                });
            }

            window.requestAnimationFrame(sample);
        };

        window.requestAnimationFrame(sample);
    });
    await page.goto(STRESS_PREVIEW_URL, { waitUntil: "domcontentloaded" });

    const timeline = page.locator('[data-ui="timeline"]');

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
    await page.waitForTimeout(2_500);

    const samples = await page.evaluate(
        () =>
            (
                window as typeof window & {
                    __openSamples?: Array<{ mode: string | null; bottomDistance: number }>;
                }
            ).__openSamples ?? [],
    );
    const firstAttached = samples.find((entry) => entry.mode === "attached");

    expect(firstAttached).toBeDefined();
    expect(
        Math.round(firstAttached?.bottomDistance ?? Number.POSITIVE_INFINITY),
    ).toBeLessThanOrEqual(SUBPIXEL_TOLERANCE_PX + 2);

    // An untouched open must not reach backwards for history it never needed.
    expect(
        await page.evaluate(
            () =>
                (window as typeof window & { __previewPaginationRequests?: number })
                    .__previewPaginationRequests ?? 0,
        ),
    ).toBe(0);

    await expect(timeline).toHaveAttribute("data-scroll-mode", "attached");
    await expectNewestMessageClearOfComposer(page, "stress-remote-append");
});
