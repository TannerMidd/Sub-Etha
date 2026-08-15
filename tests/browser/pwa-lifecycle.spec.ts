import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("a fresh browser reaches sign in without creating a notification-cleanup gate", async ({
    page,
}) => {
    await page.goto("/");

    await expect(page.locator('[data-ui="login-shell"]')).toBeVisible();
    await expect(page.getByText("NOTIFICATION CLEANUP PENDING")).toHaveCount(0);

    const cleanupMarkers = await page.evaluate(() => ({
        cleanup: localStorage.getItem("sub-etha-push-cleanup-v1"),
        intent: localStorage.getItem("sub-etha-push-cleanup-intent-v1"),
    }));

    expect(cleanupMarkers).toEqual({ cleanup: null, intent: null });
});
