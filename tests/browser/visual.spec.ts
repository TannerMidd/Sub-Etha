import { expect, test, type Page } from "@playwright/test";

const PREVIEW_URL = "/?design-preview#/room/signal-watch";
const LOGIN_PREVIEW_URL = "/?design-preview&surface-preview=login";

function captureRuntimeProblems(page: Page): string[] {
    const problems: string[] = [];

    page.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error") {
            problems.push(`${message.type()}: ${message.text()}`);
        }
    });
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));

    return problems;
}

test("Zen chat shell matches the selected line-driven reference", async ({ page }, testInfo) => {
    const runtimeProblems = captureRuntimeProblems(page);

    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
        localStorage.removeItem("sub-etha-draft:signal-watch");
    });
    await page.goto(PREVIEW_URL);
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.locator("#message-composer").fill("");
    await page.locator("#message-composer").evaluate((element) => element.blur());

    await expect(page).toHaveScreenshot(`zen-chat-shell-${testInfo.project.name}.png`, {
        animations: "disabled",
        fullPage: true,
    });
    expect(runtimeProblems).toEqual([]);
});

test("Zen login surface uses the shared line system", async ({ page }, testInfo) => {
    const runtimeProblems = captureRuntimeProblems(page);

    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
    });
    await page.goto(LOGIN_PREVIEW_URL);
    await expect(page.locator('[data-ui="login-shell"]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot(`zen-chat-login-${testInfo.project.name}.png`, {
        animations: "disabled",
        fullPage: true,
    });
    expect(runtimeProblems).toEqual([]);
});

test("Zen settings dialog uses the shared line system", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1920", "Desktop dialog reference only.");
    const runtimeProblems = captureRuntimeProblems(page);

    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
        localStorage.removeItem("sub-etha-draft:signal-watch");
    });
    await page.goto(PREVIEW_URL);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot("zen-chat-settings-desktop-1920.png", {
        animations: "disabled",
        fullPage: true,
    });
    expect(runtimeProblems).toEqual([]);
});
