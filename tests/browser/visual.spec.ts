import { expect, test } from "@playwright/test";

const PREVIEW_URL = "/?design-preview#/room/signal-watch";

test("compact dark Guide shell matches the reviewed viewport", async ({ page }, testInfo) => {
    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
        localStorage.removeItem("sub-etha-draft:signal-watch");
    });
    await page.goto(PREVIEW_URL);
    await expect(page.locator(".app-shell")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.locator("#message-composer").fill("");

    await expect(page).toHaveScreenshot(`compact-dark-${testInfo.project.name}.png`, {
        animations: "disabled",
        fullPage: true,
    });
});
