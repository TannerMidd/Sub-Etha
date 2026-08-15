import { expect, test, type Locator, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const PREVIEW_URL = "/?design-preview#/room/signal-watch";

async function openFreshPreviewDocument(page: Page, url: string): Promise<void> {
    // Pagehide intentionally scrubs the outgoing app history entry. Navigate through a neutral
    // document before opening another development-only preview surface.
    await page.goto("/manifest.webmanifest");
    await page.evaluate(() => sessionStorage.removeItem("sub-etha-route-scrub-v1"));
    await page.goto(url);
}

async function dispatchTouchSwipe(
    page: Page,
    start: { x: number; y: number },
    end: { x: number; y: number },
): Promise<void> {
    const session = await page.context().newCDPSession(page);

    await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: start.x, y: start.y }],
    });
    await page.waitForTimeout(24);

    for (let step = 1; step <= 5; step += 1) {
        const progress = step / 5;

        await session.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [
                {
                    x: start.x + (end.x - start.x) * progress,
                    y: start.y + (end.y - start.y) * progress,
                },
            ],
        });
        await page.waitForTimeout(18);
    }

    await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
    });
    await page.waitForTimeout(24);
    await session.detach();
}

async function dispatchLongPress(page: Page, point: { x: number; y: number }): Promise<void> {
    const session = await page.context().newCDPSession(page);

    await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [point],
    });
    await page.waitForTimeout(700);
    await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
    });
    await session.detach();
}

async function browserHighlightStyle(locator: Locator): Promise<{
    tapHighlightColor: string;
    userSelect: string;
    webkitUserSelect: string;
}> {
    return locator.evaluate((element) => {
        const style = getComputedStyle(element);

        return {
            tapHighlightColor: style.getPropertyValue("-webkit-tap-highlight-color"),
            userSelect: style.userSelect,
            webkitUserSelect: style.getPropertyValue("-webkit-user-select"),
        };
    });
}

async function replaceSelectedText(
    page: Page,
    field: Locator,
    initialValue: string,
    start: number,
    end: number,
    replacement: string,
    expectedValue: string,
): Promise<void> {
    await expect(field).toBeVisible();
    await expect(browserHighlightStyle(field)).resolves.toMatchObject({
        userSelect: "text",
        webkitUserSelect: "text",
    });
    await field.fill(initialValue);
    await field.focus();
    await field.evaluate(
        (element, selection) => {
            (element as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(
                selection.start,
                selection.end,
            );
        },
        { start, end },
    );
    await page.keyboard.insertText(replacement);
    await expect(field).toHaveValue(expectedValue);
}

test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "Mobile interaction coverage only.");
    await page.goto(PREVIEW_URL);
    await expect(page.locator('[data-ui="conversation-header"]')).toBeVisible();
});

test("edge swipes open and close the room index while vertical scrolling wins", async ({
    page,
}) => {
    const shell = page.locator('[data-ui="app-shell"]');

    await dispatchTouchSwipe(page, { x: 12, y: 420 }, { x: 110, y: 424 });
    await expect(shell).toHaveAttribute("data-rooms-state", "open");
    await expect(page).not.toHaveURL(/#\/room\//);
    await page.waitForTimeout(250);

    await dispatchTouchSwipe(page, { x: 180, y: 30 }, { x: 80, y: 34 });
    await expect(shell).toHaveAttribute("data-rooms-state", "closed");

    await dispatchTouchSwipe(page, { x: 12, y: 300 }, { x: 18, y: 560 });
    await expect(shell).toHaveAttribute("data-rooms-state", "closed");
});

test("dialogs and text controls exclude the global edge swipe", async ({ page }) => {
    const shell = page.locator('[data-ui="app-shell"]');

    await page.getByRole("button", { name: "Room details" }).click();
    await expect(page.getByRole("dialog", { name: "Signal Watch" })).toBeVisible();
    await dispatchTouchSwipe(page, { x: 12, y: 420 }, { x: 120, y: 420 });
    await expect(shell).toHaveAttribute("data-rooms-state", "closed");
    await page.getByRole("button", { name: "Close" }).click();

    const attachmentControl = page.getByRole("button", { name: "Attach a file" });
    const attachmentBounds = await attachmentControl.boundingBox();

    expect(attachmentBounds).not.toBeNull();
    const attachmentX = (attachmentBounds?.x ?? 0) + 1;
    const attachmentY = (attachmentBounds?.y ?? 0) + (attachmentBounds?.height ?? 0) / 2;

    await dispatchTouchSwipe(
        page,
        { x: attachmentX, y: attachmentY },
        { x: attachmentX + 108, y: attachmentY },
    );
    await expect(shell).toHaveAttribute("data-rooms-state", "closed");
});

test("app chrome cannot retain browser tap or selection highlights", async ({ page }) => {
    const heading = page.getByRole("heading", { name: "Signal Watch" });
    const chrome = [
        page.locator('[data-ui="app-shell"]'),
        page.locator('[data-ui="conversation-header"]'),
        heading,
        page.locator('[data-ui="message-row"]').first(),
        page.getByRole("button", { name: "Room details" }),
    ];

    for (const element of chrome) {
        await expect(element).toBeVisible();
        await expect(browserHighlightStyle(element)).resolves.toEqual({
            tapHighlightColor: "rgba(0, 0, 0, 0)",
            userSelect: "none",
            webkitUserSelect: "none",
        });
    }

    const headingBounds = await heading.boundingBox();

    expect(headingBounds).not.toBeNull();

    if (!headingBounds) {
        return;
    }

    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.mouse.move(headingBounds.x + 2, headingBounds.y + headingBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(
        headingBounds.x + headingBounds.width - 2,
        headingBounds.y + headingBounds.height / 2,
        { steps: 5 },
    );
    await page.mouse.up();
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

    await dispatchLongPress(page, {
        x: headingBounds.x + headingBounds.width / 2,
        y: headingBounds.y + headingBounds.height / 2,
    });
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");

    await page.getByRole("button", { name: "Open transmission index" }).click();
    const roomName = page.getByRole("button", { name: /Hab Drift Crew/ });

    await expect(roomName).toBeVisible();
    await expect(browserHighlightStyle(roomName)).resolves.toMatchObject({
        tapHighlightColor: "rgba(0, 0, 0, 0)",
        userSelect: "none",
        webkitUserSelect: "none",
    });
});

test("editable fields retain native text selection and replacement", async ({ page }) => {
    await replaceSelectedText(
        page,
        page.locator("#message-composer"),
        "alpha beta",
        6,
        10,
        "gamma",
        "alpha gamma",
    );

    await page.getByRole("button", { name: "Open transmission index" }).click();
    await replaceSelectedText(
        page,
        page.locator("#transmission-search"),
        "signal watch",
        0,
        6,
        "hab",
        "hab watch",
    );

    await openFreshPreviewDocument(
        page,
        "/?design-preview&surface-preview=settings#/room/signal-watch",
    );
    await replaceSelectedText(
        page,
        page.locator("#display-name"),
        "Field Rayne",
        6,
        11,
        "Agent",
        "Field Agent",
    );

    await openFreshPreviewDocument(page, "/?design-preview&surface-preview=login");
    await replaceSelectedText(
        page,
        page.locator("#homeserver"),
        "@rayne:example.org",
        1,
        6,
        "nova",
        "@nova:example.org",
    );
});

test("header Back, room selection, and browser Back preserve mobile history", async ({ page }) => {
    const shell = page.locator('[data-ui="app-shell"]');
    const indexButton = page.getByRole("button", { name: "Open transmission index" });

    await indexButton.click();
    await expect(shell).toHaveAttribute("data-rooms-state", "open");
    await page.getByRole("button", { name: /Hab Drift Crew/ }).click();
    const roomHeading = page.getByRole("heading", { name: "Hab Drift Crew" });

    await expect(roomHeading).toBeVisible();
    await expect(shell).toHaveAttribute("data-rooms-state", "closed");
    await expect(roomHeading).toBeFocused();
    await expect(indexButton).not.toBeFocused();
    await expect(page.locator("#message-composer")).not.toBeFocused();
    expect(await indexButton.evaluate((element) => element.matches(":focus-visible"))).toBe(false);

    await page.goBack();
    await expect(shell).toHaveAttribute("data-rooms-state", "open");
    await expect(page.locator('[data-ui="room-sidebar"]')).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(shell).toHaveAttribute("data-rooms-state", "closed");
    await expect(indexButton).toBeFocused();
});

test("reduced motion removes drawer and dialog transition timing", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFreshPreviewDocument(page, PREVIEW_URL);
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();

    const durations = await Promise.all(
        [page.locator('[data-ui="room-sidebar"]'), page.locator('[data-ui="sidebar-scrim"]')].map(
            (locator) =>
                locator.evaluate((element) => getComputedStyle(element).transitionDuration),
        ),
    );

    expect(durations).toEqual(["0s", "0s"]);
});

test("the installed shell reports safe-area insets and never triggers focus zoom", async ({
    page,
}) => {
    const viewport = await page
        .locator('meta[name="viewport"]')
        .evaluate((element) => element.getAttribute("content") ?? "");

    // Without viewport-fit=cover every env(safe-area-inset-*) in the stylesheets
    // reports 0px, and the black-translucent status bar draws over the header.
    expect(viewport).toContain("viewport-fit=cover");

    // iOS zooms the page when a control smaller than 16px takes focus, and an
    // installed shell has no way back out of that zoom.
    for (const url of [
        PREVIEW_URL,
        "/?design-preview&surface-preview=settings#/room/signal-watch",
        "/?design-preview&surface-preview=login",
    ]) {
        await openFreshPreviewDocument(page, url);
        await expect(page).toHaveURL(/design-preview/);
        await expect(page.locator("body")).toBeVisible();

        const fontSizes = await page.evaluate(() =>
            [...document.querySelectorAll("input, textarea, select")].map((element) =>
                Number.parseFloat(getComputedStyle(element).fontSize),
            ),
        );

        for (const fontSize of fontSizes) {
            expect(
                fontSize,
                `${url} has a control below the iOS zoom threshold`,
            ).toBeGreaterThanOrEqual(16);
        }
    }
});
