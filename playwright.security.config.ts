import { defineConfig } from "@playwright/test";

const browserChannel =
    process.env.PLAYWRIGHT_CHANNEL ?? (process.platform === "win32" ? "msedge" : undefined);

export default defineConfig({
    testDir: "./tests/security-browser",
    fullyParallel: false,
    workers: 1,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: [["list"]],
    use: {
        baseURL: "http://localhost:4174",
        ...(browserChannel ? { channel: browserChannel } : {}),
        trace: "retain-on-failure",
    },
    webServer: {
        command: "npm run start -- --port 4174",
        url: "http://localhost:4174/?design-preview&surface-preview=login",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
    },
    projects: [{ name: "production-security", use: { viewport: { width: 1280, height: 900 } } }],
});
