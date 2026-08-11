import { defineConfig } from "@playwright/test";

const browserChannel =
    process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined);

export default defineConfig({
    testDir: "./tests/browser",
    testMatch: "visual.spec.ts",
    fullyParallel: false,
    workers: 1,
    timeout: 45_000,
    expect: {
        timeout: 8_000,
        toHaveScreenshot: {
            maxDiffPixelRatio: 0.005,
        },
    },
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: "http://localhost:4174",
        ...(browserChannel ? { channel: browserChannel } : {}),
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
    },
    webServer: {
        command: "npm run start -- --port 4174",
        url: "http://localhost:4174/?design-preview&surface-preview=login",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
    projects: [
        {
            name: "desktop-1920",
            use: { viewport: { width: 1920, height: 1080 } },
        },
        {
            name: "mobile-390",
            use: {
                viewport: { width: 390, height: 844 },
                isMobile: true,
                hasTouch: true,
            },
        },
    ],
});
