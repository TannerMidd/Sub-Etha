import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("mobile lightbox handles two-touch zoom inside the stage", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "Mobile gesture coverage only.");

    await page.goto("/?design-preview&ux-preview=media#/room/signal-watch");
    await expect(page.locator("#message-composer")).toBeVisible();

    const opener = page.getByRole("button", {
        name: "View Receiver plate recovered from the archive.",
    });

    await expect(opener).toBeVisible();
    await opener.click();

    const stage = page.locator('[class*="lightbox__stage"]');
    const zoomValue = page.locator('[class*="lightbox__zoom-value"]');

    await expect(stage).toBeVisible();
    await expect(zoomValue).toHaveText("100%");
    await expect(stage).toHaveCSS("touch-action", "none");

    const pageScaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);
    const bounds = await stage.boundingBox();

    expect(bounds).not.toBeNull();

    const centerY = (bounds?.y ?? 0) + (bounds?.height ?? 0) / 2;
    const centerX = (bounds?.x ?? 0) + (bounds?.width ?? 0) / 2;
    const cdp = await page.context().newCDPSession(page);

    await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
            { id: 1, x: centerX - 40, y: centerY },
            { id: 2, x: centerX + 40, y: centerY },
        ],
    });
    await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
            { id: 1, x: centerX - 80, y: centerY },
            { id: 2, x: centerX + 80, y: centerY },
        ],
    });

    await expect(zoomValue).toHaveText("200%");
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(pageScaleBefore);

    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.getByRole("button", { name: "Close image viewer" }).click();
    await expect(stage).toHaveCount(0);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(pageScaleBefore);
});
