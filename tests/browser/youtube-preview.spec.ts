import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block" });

test("YouTube cards stay browser-direct, lazy, inert on failure, and stable across remounts", async ({
    page,
}) => {
    let requestCount = 0;
    let requestReferer: string | undefined;
    let releaseThumbnailRequest!: () => void;
    const thumbnailRequestReleased = new Promise<void>((resolve) => {
        releaseThumbnailRequest = resolve;
    });

    await page.route("https://i.ytimg.com/vi/**", async (route) => {
        requestCount += 1;
        requestReferer = route.request().headers().referer;
        await thumbnailRequestReleased;
        await route.abort();
    });

    await page.goto("/?design-preview&ux-preview=timeline-stress#/room/signal-watch");
    await expect(page.locator("#message-composer")).toBeVisible();
    const documentIdentity = await page.evaluate(() => {
        const scopedWindow = window as typeof window & { __youtubePreviewDocumentId?: string };

        scopedWindow.__youtubePreviewDocumentId = crypto.randomUUID();

        return {
            id: scopedWindow.__youtubePreviewDocumentId,
            navigationEntries: performance.getEntriesByType("navigation").length,
        };
    });

    const body = "https://youtu.be/Abc_def-123";
    const textarea = page.locator("#message-composer");

    await textarea.fill(body);
    await page.getByRole("button", { name: "Send message" }).click();

    const image = page.locator('img[src="https://i.ytimg.com/vi/Abc_def-123/hqdefault.jpg"]');
    const imageRow = image.locator("xpath=ancestor::article[1]");

    await expect(imageRow).toBeVisible();
    const eventId = await imageRow.getAttribute("data-event-id");

    expect(eventId).not.toBeNull();

    const row = page.locator(`[data-event-id="${eventId}"]`);
    const card = row.locator(
        '[class*="youtube-preview"]:not([class*="youtube-preview-list"]):not([class*="youtube-preview__"])',
    );
    const link = row.locator('a[href="https://www.youtube.com/watch?v=Abc_def-123"]');

    await expect(card).toBeVisible();
    await expect(image).toHaveAttribute("src", "https://i.ytimg.com/vi/Abc_def-123/hqdefault.jpg");
    await expect(image).toHaveAttribute("loading", "lazy");
    await expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(link).toHaveAttribute("href", "https://www.youtube.com/watch?v=Abc_def-123");

    const beforeFailure = await card.boundingBox();
    const scroller = page.locator('[data-virtuoso-scroller="true"]');

    expect(beforeFailure).not.toBeNull();
    expect(beforeFailure?.width ?? 0).toBeLessThanOrEqual(481);

    if (page.viewportSize()?.width === 1920) {
        expect(beforeFailure?.width ?? 0).toBeGreaterThanOrEqual(479);
    }

    expect(
        Math.abs((beforeFailure?.height ?? 0) - (beforeFailure?.width ?? 0) * 0.75 - 46),
    ).toBeLessThanOrEqual(3);

    await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => requestCount).toBe(1);
    releaseThumbnailRequest();
    await expect(image).toHaveCount(0);
    await expect(link).toHaveCount(0);
    await expect(card.locator("button, iframe, script, img")).toHaveCount(0);
    expect(requestReferer).toBeUndefined();

    const afterFailure = await card.boundingBox();

    expect(afterFailure).not.toBeNull();
    expect(Math.abs((afterFailure?.width ?? 0) - (beforeFailure?.width ?? 0))).toBeLessThanOrEqual(
        1,
    );
    expect(
        Math.abs((afterFailure?.height ?? 0) - (beforeFailure?.height ?? 0)),
    ).toBeLessThanOrEqual(1);

    await scroller.evaluate((element) => {
        element.scrollTop = 0;
    });
    await page.waitForTimeout(150);
    await scroller.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
    });
    await expect(card).toBeVisible();
    await expect.poll(() => requestCount).toBe(1);

    await page.evaluate(() => {
        window.location.hash = "#/room/hab-drift";
    });
    await expect(page).toHaveURL(/#\/room\/hab-drift$/);
    await expect(card).toBeVisible();

    await page.evaluate(() => {
        window.location.hash = "#/room/signal-watch";
    });
    await expect(page).toHaveURL(/#\/room\/signal-watch$/);
    await expect(card).toBeVisible();
    await expect.poll(() => requestCount).toBe(1);
    expect(
        await page.evaluate(() => {
            const scopedWindow = window as typeof window & {
                __youtubePreviewDocumentId?: string;
            };

            return {
                id: scopedWindow.__youtubePreviewDocumentId,
                navigationEntries: performance.getEntriesByType("navigation").length,
            };
        }),
    ).toEqual(documentIdentity);
});
