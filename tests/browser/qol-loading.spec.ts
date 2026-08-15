import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("the timeline placeholder holds the real row geometry", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("sub-etha-theme", "dark"));
    await page.goto("/?design-preview&ux-preview=loading#/room/signal-watch");

    const placeholder = page.locator('[data-ui="conversation-stage"] [data-ui="skeleton"]');

    await expect(placeholder).toBeAttached();
    await expect(placeholder).toContainText("Loading messages");
    await expect(page.locator('[data-ui="message-row"]')).toHaveCount(0);

    const geometry = await placeholder.evaluate((group) => {
        const frame = group.closest('[aria-label="Room messages"]')!;
        const row = group.querySelector("div")!;
        const main = row.querySelector("div")!;
        const marker = main.querySelector("span")!;
        const bar = row.querySelector("i")!;
        const barStyle = getComputedStyle(bar);

        return {
            rows: group.querySelectorAll(":scope > div").length,
            timeLane: getComputedStyle(row).gridTemplateColumns.split(" ")[0],
            frameTimeLane: getComputedStyle(frame).getPropertyValue("--timeline-time").trim(),
            markerWidth: getComputedStyle(marker).width,
            markerOffset: getComputedStyle(marker).left,
            frameGutter: getComputedStyle(frame).getPropertyValue("--timeline-gap").trim(),
            shimmer: barStyle.animationName,
            shimmerDuration: barStyle.animationDuration,
            backgroundSize: barStyle.backgroundSize,
        };
    });

    // The lanes come from the frame rather than from the placeholder, so the
    // rows stand on the same axis the real messages will at any width.
    expect(geometry.rows).toBe(5);
    expect(geometry.timeLane).toBe(geometry.frameTimeLane);
    expect(geometry.markerWidth).toBe("3px");
    expect(geometry.markerOffset).toBe(`-${Number.parseInt(geometry.frameGutter, 10) + 1}px`);
    expect(geometry.shimmer).toMatch(/shimmer/);
    expect(geometry.shimmerDuration).toBe("2.6s");
    expect(geometry.backgroundSize).toBe("260% 100%");
});

test("a settled message carries no entrance marker", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("sub-etha-theme", "dark"));
    await page.goto("/?design-preview#/room/signal-watch");
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();

    const rows = page.locator('[data-ui="message-row"]');

    await expect(rows.first()).toBeVisible();
    await expect(page.locator('[data-ui="message-row"][data-enter="in"]')).toHaveCount(0);
});

test("a sent message enters once and is held back until it lands", async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
        localStorage.removeItem("sub-etha-draft:signal-watch");
    });
    await page.goto("/?design-preview#/room/signal-watch");
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();

    await page.locator("#message-composer").fill("Confirmed.");
    await page.locator("#message-composer").press("Enter");

    const sent = page.locator('[data-ui="message-row"]').last();

    await expect(sent).toHaveAttribute("data-enter", "in");
    await expect(sent).not.toHaveAttribute("data-enter", "in", { timeout: 3_000 });
});

test("the first message after an empty room initializes carries an entrance marker", async ({
    page,
}) => {
    await page.addInitScript(() => localStorage.setItem("sub-etha-theme", "dark"));
    await page.goto("/?design-preview&ux-preview=timeline-entrance-empty#/room/signal-watch");

    const firstMessage = page.locator('[data-event-id="entrance-empty"]');

    await expect(firstMessage).toHaveAttribute("data-enter", "in");
    await expect(firstMessage).not.toHaveAttribute("data-enter", "in", { timeout: 3_000 });
});

test("local-echo reconciliation does not replay the entrance marker", async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem("sub-etha-theme", "dark");
        localStorage.removeItem("sub-etha-draft:signal-watch");
    });
    await page.goto(
        "/?design-preview&ux-preview=timeline-entrance-reconciliation#/room/signal-watch",
    );
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();

    await page.locator("#message-composer").fill("Confirmed locally.");
    await page.locator("#message-composer").press("Enter");

    await expect(page.locator('[data-event-id="entrance-pending"]')).toHaveAttribute(
        "data-enter",
        "in",
    );

    const confirmed = page.locator('[data-event-id="entrance-confirmed"]');

    await expect(confirmed).toBeVisible();
    await expect(confirmed).not.toHaveAttribute("data-enter", "in");
});

test("rapid arrivals keep each row's entrance marker alive independently", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("sub-etha-theme", "dark"));
    await page.goto("/?design-preview&ux-preview=timeline-entrance-burst#/room/signal-watch");

    const first = page.locator('[data-event-id="entrance-burst-first"]');
    const second = page.locator('[data-event-id="entrance-burst-second"]');

    await expect(first).toHaveAttribute("data-enter", "in");
    await expect(second).toHaveAttribute("data-enter", "in");
    await page.waitForTimeout(120);
    await expect(first).toHaveAttribute("data-enter", "in");
    await expect(first).not.toHaveAttribute("data-enter", "in", { timeout: 2_000 });
    await expect(second).not.toHaveAttribute("data-enter", "in", { timeout: 2_000 });
});
