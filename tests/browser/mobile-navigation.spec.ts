import { expect, test, type Page } from "@playwright/test";

const PREVIEW_URL = "/?design-preview#/room/signal-watch";

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
    await dispatchTouchSwipe(
        page,
        { x: 12, y: (attachmentBounds?.y ?? 0) + (attachmentBounds?.height ?? 0) / 2 },
        { x: 120, y: (attachmentBounds?.y ?? 0) + (attachmentBounds?.height ?? 0) / 2 },
    );
    await expect(shell).toHaveAttribute("data-rooms-state", "closed");
});

test("header Back, room selection, and browser Back preserve mobile history", async ({ page }) => {
    const shell = page.locator('[data-ui="app-shell"]');

    await page.getByRole("button", { name: "Open transmission index" }).click();
    await expect(shell).toHaveAttribute("data-rooms-state", "open");
    await page.getByRole("button", { name: /Hab Drift Crew/ }).click();
    await expect(page.getByRole("heading", { name: "Hab Drift Crew" })).toBeVisible();
    await expect(shell).toHaveAttribute("data-rooms-state", "closed");

    await page.goBack();
    await expect(shell).toHaveAttribute("data-rooms-state", "open");
    await expect(page.locator('[data-ui="room-sidebar"]')).toBeVisible();
});

test("reduced motion removes drawer and dialog transition timing", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();

    const durations = await Promise.all(
        [page.locator('[data-ui="room-sidebar"]'), page.locator('[data-ui="sidebar-scrim"]')].map(
            (locator) =>
                locator.evaluate((element) => getComputedStyle(element).transitionDuration),
        ),
    );

    expect(durations).toEqual(["0s", "0s"]);
});
