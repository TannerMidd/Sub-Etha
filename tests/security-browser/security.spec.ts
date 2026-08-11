import { expect, test, type Page } from "@playwright/test";

const LOGIN_URL = "/?design-preview&surface-preview=login";
const APP_URL = "/?design-preview#/room/signal-watch";

async function installViolationCapture(page: Page): Promise<void> {
    await page.addInitScript(() => {
        const violations: string[] = [];

        Object.defineProperty(window, "__subEthaCspViolations", {
            configurable: true,
            value: violations,
        });
        document.addEventListener("securitypolicyviolation", (event) => {
            violations.push(
                [
                    event.violatedDirective,
                    event.blockedURI,
                    event.sourceFile,
                    event.lineNumber,
                ].join(" | "),
            );
        });
    });
}

async function violations(page: Page): Promise<string[]> {
    return page.evaluate(
        () =>
            (
                window as typeof window & {
                    __subEthaCspViolations?: string[];
                }
            ).__subEthaCspViolations ?? [],
    );
}

test("production documents enforce nonce CSP and supporting security headers", async ({ page }) => {
    await installViolationCapture(page);
    const response = await page.goto(LOGIN_URL);

    expect(response).not.toBeNull();

    const headers = response!.headers();
    const csp = headers["content-security-policy"];

    expect(csp).toBeTruthy();
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["origin-agent-cluster"]).toBe("?1");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["permissions-policy"]).not.toContain("notifications=()");

    const scriptSource = csp
        .split(";")
        .map((directive) => directive.trim())
        .find((directive) => directive.startsWith("script-src "));

    expect(scriptSource).toContain("'strict-dynamic'");
    expect(scriptSource).toContain("'wasm-unsafe-eval'");
    expect(scriptSource).not.toContain("'unsafe-inline'");
    expect(scriptSource).not.toContain("'unsafe-eval'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");

    const nonce = scriptSource?.match(/'nonce-([A-Za-z0-9_-]{22})'/)?.[1];

    expect(nonce).toBeTruthy();
    const scriptNonces = await page
        .locator("script")
        .evaluateAll((scripts) => scripts.map((script) => script.nonce));

    expect(scriptNonces.length).toBeGreaterThan(0);
    expect(scriptNonces.every((candidate) => candidate === nonce)).toBe(true);

    await expect(page.locator('[data-ui="login-shell"]')).toBeVisible();
    await page.waitForTimeout(250);
    expect(await violations(page)).toEqual([]);
});

test("production CSP permits required lazy UI, worker, blob media, and Wasm only", async ({
    page,
}) => {
    await installViolationCapture(page);
    const runtimeProblems: string[] = [];

    page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) {
            runtimeProblems.push(message.text());
        }
    });
    page.on("pageerror", (error) => runtimeProblems.push(error.message));

    await page.goto(APP_URL);
    await expect(page.locator('[data-ui="app-shell"]')).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Choose an emoji" }).click();
    await expect(page.locator(".EmojiPickerReact")).toBeVisible();

    const smoke = await page.evaluate(async () => {
        const wasm = await WebAssembly.compile(
            new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
        );
        const blob = new Blob(
            [
                Uint8Array.from(
                    atob(
                        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9xkAAAAASUVORK5CYII=",
                    ),
                    (character) => character.charCodeAt(0),
                ),
            ],
            { type: "image/png" },
        );
        const url = URL.createObjectURL(blob);
        const imageLoaded = await new Promise<boolean>((resolve) => {
            const image = new Image();

            image.onload = () => resolve(true);
            image.onerror = () => resolve(false);
            image.src = url;
        });

        URL.revokeObjectURL(url);

        const registration =
            "serviceWorker" in navigator
                ? await navigator.serviceWorker.register("/sw.js", { scope: "/" })
                : undefined;

        if (registration) {
            await navigator.serviceWorker.ready;
        }

        return {
            imageLoaded,
            serviceWorker: Boolean(registration),
            wasm: wasm instanceof WebAssembly.Module,
        };
    });

    expect(smoke).toEqual({ imageLoaded: true, serviceWorker: true, wasm: true });
    await page.waitForTimeout(500);
    expect(await violations(page)).toEqual([]);
    expect(runtimeProblems).toEqual([]);
});
