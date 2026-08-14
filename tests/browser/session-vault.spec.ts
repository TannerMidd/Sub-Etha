import { expect, test, type Page } from "@playwright/test";

function runtimeProblems(page: Page): string[] {
    const problems: string[] = [];

    page.on("console", (message) => {
        if (message.type() === "warning" || message.type() === "error") {
            problems.push(`${message.type()}: ${message.text()}`);
        }
    });
    page.on("pageerror", (error) => {
        problems.push(`pageerror: ${error.message}`);
    });

    return problems;
}

test("session enrollment requires an exact recovery-key confirmation", async ({ page }) => {
    const problems = runtimeProblems(page);

    await page.goto("/?design-preview&surface-preview=vault-enrollment");
    await expect(page.locator('[data-ui="session-vault-enrollment"]')).toBeVisible();

    const continueButton = page.getByRole("button", { name: "Secure and continue" });
    const recoveryKey = await page.locator('[data-ui="vault-recovery-key"] code').textContent();

    expect(recoveryKey).toBeTruthy();
    await expect(continueButton).toBeDisabled();
    await page.getByLabel("Paste the recovery key to confirm you saved it").fill("wrong");
    await expect(continueButton).toBeDisabled();
    await page.getByLabel("Paste the recovery key to confirm you saved it").fill(recoveryKey ?? "");
    await expect(continueButton).toBeEnabled();
    expect(problems).toEqual([]);
});

test("locked sessions always retain recovery unlock and require reset confirmation", async ({
    page,
}) => {
    const problems = runtimeProblems(page);

    await page.goto("/?design-preview&surface-preview=vault-locked");
    await expect(page.locator('[data-ui="session-vault-locked"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlock with this device" })).toBeVisible();
    await expect(page.getByLabel("Recovery key")).toBeVisible();
    await expect(page.getByRole("button", { name: "Unlock with recovery key" })).toBeDisabled();

    await page.getByLabel("Recovery key").fill("example-recovery-key");
    await expect(page.getByRole("button", { name: "Unlock with recovery key" })).toBeEnabled();

    const reset = page.getByRole("button", { name: "Forget this browser" });

    await reset.click();
    await expect(page.getByRole("button", { name: "Confirm local reset" })).toBeVisible();
    await expect(page.getByText(/does not revoke the Matrix session/i)).toBeVisible();
    expect(problems).toEqual([]);
});

test("history restoration never resumes a heap that held sensitive app state", async ({ page }) => {
    const problems = runtimeProblems(page);

    await page.goto("/?design-preview");
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();
    await page.evaluate(() => {
        (window as typeof window & { __subEthaPageSecret?: string }).__subEthaPageSecret =
            "sensitive-canary";
    });

    await page.goto("/?design-preview&surface-preview=login");
    await expect(page.locator('[data-ui="login-shell"]')).toBeVisible();
    await page.goBack();
    await page.waitForFunction(
        () =>
            (window as typeof window & { __subEthaPageSecret?: string }).__subEthaPageSecret ===
            undefined,
    );
    await expect(page.locator('[data-ui="login-shell"]')).toBeVisible();
    await expect.poll(() => page.url()).toMatch(/\/$/);
    expect(problems).toEqual([]);
});
