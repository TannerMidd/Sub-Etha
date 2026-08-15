import { expect, test, type Page } from "@playwright/test";

test.use({ serviceWorkers: "block" });

const PREVIEW_URL = "/?design-preview#/room/signal-watch";
const LIGHT_PREVIEW_URL = "/?design-preview&theme=light#/room/signal-watch";
const LOGIN_PREVIEW_URL = "/?design-preview&surface-preview=login";
const SETTINGS_PREVIEW_URL = "/?design-preview&surface-preview=settings#/room/signal-watch";
const LIGHT_SETTINGS_PREVIEW_URL =
    "/?design-preview&surface-preview=settings&theme=light#/room/signal-watch";
const ROOMS_PREVIEW_URL = "/?design-preview&surface-preview=rooms";
const EMPTY_PREVIEW_URL = "/?design-preview&surface-preview=empty";
const INVITE_PREVIEW_URL = "/?design-preview&surface-preview=invite#/room/observatory-invite";

async function openFreshPreviewDocument(page: Page, url: string): Promise<void> {
    // The app deliberately scrubs the current history entry during pagehide. Leave that document
    // first so a test that needs another preview surface does not mistake the safe login route for
    // its requested fresh-document state.
    await page.goto("/manifest.webmanifest");
    await page.evaluate(() => sessionStorage.removeItem("sub-etha-route-scrub-v1"));
    await page.goto(url);
}

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

test("Zen chat shell keeps message rows quiet and unboxed", async ({ page }, testInfo) => {
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

test("Zen chat sender cues remain subtle in the light theme", async ({ page }, testInfo) => {
    const runtimeProblems = captureRuntimeProblems(page);

    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "light");
        localStorage.removeItem("sub-etha-draft:signal-watch");
    });
    await page.goto(LIGHT_PREVIEW_URL);
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.locator("#message-composer").fill("");
    await page.locator("#message-composer").evaluate((element) => element.blur());

    await expect(page).toHaveScreenshot(`zen-chat-shell-light-${testInfo.project.name}.png`, {
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
    await page.goto(SETTINGS_PREVIEW_URL);
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot("zen-chat-settings-desktop-1920.png", {
        animations: "disabled",
        fullPage: true,
    });
    expect(runtimeProblems).toEqual([]);
});

test("settings preview keeps its URL theme, selector, and palette synchronized", async ({
    page,
}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1920", "Desktop dialog behavior only.");

    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "system");
    });

    await page.goto(LIGHT_SETTINGS_PREVIEW_URL);

    const themeGroup = page.getByRole("group", { name: "Theme" });

    await expect(themeGroup.getByRole("button", { name: "Light" })).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await themeGroup.getByRole("button", { name: "Dark" }).click();

    await expect(page).toHaveURL(/theme=dark/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("sub-etha-theme"))).toBe("system");

    const selectedThemeUrl = page.url();

    await openFreshPreviewDocument(page, selectedThemeUrl);
    await expect(themeGroup.getByRole("button", { name: "Dark" })).toHaveAttribute(
        "aria-pressed",
        "true",
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("Zen mobile room index matches the selected reference", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-390", "Mobile room index reference only.");
    const runtimeProblems = captureRuntimeProblems(page);

    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
    });
    await page.goto(ROOMS_PREVIEW_URL);
    await expect(page.locator('[data-ui="room-sidebar"]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot("zen-chat-rooms-mobile-390.png", {
        animations: "disabled",
        fullPage: true,
    });
    expect(runtimeProblems).toEqual([]);
});

test("Zen empty room state uses the quiet centered treatment", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1920", "Desktop empty-state reference only.");
    const runtimeProblems = captureRuntimeProblems(page);

    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
    });
    await page.goto(EMPTY_PREVIEW_URL);
    await expect(page.getByRole("heading", { name: "Nothing selected." })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot("zen-chat-empty-desktop-1920.png", {
        animations: "disabled",
        fullPage: true,
    });
    expect(runtimeProblems).toEqual([]);
});

test("Zen invitation state uses the quiet decision treatment", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-1920", "Desktop invitation reference only.");
    const runtimeProblems = captureRuntimeProblems(page);

    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
    });
    await page.goto(INVITE_PREVIEW_URL);
    await expect(page.getByRole("heading", { name: /invited you to Observatory/i })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    await expect(page).toHaveScreenshot("zen-chat-invite-desktop-1920.png", {
        animations: "disabled",
        fullPage: true,
    });
    expect(runtimeProblems).toEqual([]);
});
