import { defineConfig } from "@playwright/test";

const browserChannel =
    process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined);

export default defineConfig({
    testDir: "./tests/browser",
    fullyParallel: false,
    workers: 1,
    timeout: 45_000,
    expect: {
        timeout: 8_000,
    },
    reporter: [["list"], ["html", { open: "never" }]],
    use: {
        baseURL: "http://localhost:4173",
        ...(browserChannel ? { channel: browserChannel } : {}),
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
    },
    webServer: {
        command: "npm run dev -- --port 4173",
        url: "http://localhost:4173/?design-preview#/room/signal-watch",
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
