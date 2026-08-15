import { expect, test, type APIResponse } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { request as httpRequest } from "node:http";

import {
    buildContentSecurityPolicy,
    CONTENT_SECURITY_POLICY,
    CONTENT_SECURITY_POLICY_REPORT_ONLY,
    DOCUMENT_SECURITY_HEADERS,
} from "../../lib/security/csp";

const DOCUMENT_REQUEST_HEADERS = {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
};
const useBuiltNitroServer =
    process.env.PLAYWRIGHT_NITRO_SERVER === "1" && Boolean(process.env.PLAYWRIGHT_BASE_URL);

interface RuntimeResponse {
    body: string;
    headerEntries: Array<{ name: string; value: string }>;
    headers: Record<string, string>;
    status: number;
}

async function playwrightResponse(response: APIResponse): Promise<RuntimeResponse> {
    return {
        body: await response.text(),
        headerEntries: response.headersArray(),
        headers: response.headers(),
        status: response.status(),
    };
}

function documentRequestWithoutAccept(baseURL: string): Promise<RuntimeResponse> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(new URL("/", baseURL), (response) => {
            const chunks: Buffer[] = [];

            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => {
                const headers: Record<string, string> = {};

                for (const [name, value] of Object.entries(response.headers)) {
                    if (value !== undefined) {
                        headers[name] = Array.isArray(value) ? value.join(", ") : value;
                    }
                }

                const headerEntries: RuntimeResponse["headerEntries"] = [];

                for (let index = 0; index < response.rawHeaders.length; index += 2) {
                    headerEntries.push({
                        name: response.rawHeaders[index],
                        value: response.rawHeaders[index + 1],
                    });
                }

                resolve({
                    body: Buffer.concat(chunks).toString("utf8"),
                    headerEntries,
                    headers,
                    status: response.statusCode ?? 0,
                });
            });
        });

        request.on("error", reject);
        request.end();
    });
}

function policyNonce(policy: string): string {
    const scriptDirective = policy
        .split("; ")
        .find((directive) => directive.startsWith("script-src "));
    const match = scriptDirective?.match(/'nonce-([A-Za-z0-9_-]{22})'/);

    expect(match, "script-src must carry one 16-byte base64url nonce").not.toBeNull();

    return match?.[1] ?? "";
}

function openingTags(html: string, tagName: "script" | "style"): string[] {
    return [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gi"))].map(
        ([openingTag]) => openingTag,
    );
}

function nonceAttribute(openingTag: string): string | null {
    const match = openingTag.match(/\snonce=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);

    return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function assertSecuredDocument(response: RuntimeResponse): {
    nonce: string;
    policy: string;
} {
    expect(response.status).toBe(200);
    const headers = response.headers;
    const policy = headers[CONTENT_SECURITY_POLICY.toLowerCase()];
    const reportOnlyPolicy = headers[CONTENT_SECURITY_POLICY_REPORT_ONLY.toLowerCase()];

    expect(policy).toBeDefined();
    expect(reportOnlyPolicy).toBeUndefined();
    expect(
        response.headerEntries.filter(
            ({ name }) => name.toLowerCase() === CONTENT_SECURITY_POLICY.toLowerCase(),
        ),
    ).toHaveLength(1);
    expect(
        response.headerEntries.filter(
            ({ name }) => name.toLowerCase() === CONTENT_SECURITY_POLICY_REPORT_ONLY.toLowerCase(),
        ),
    ).toHaveLength(0);

    const nonce = policyNonce(policy);

    expect(policy).toBe(buildContentSecurityPolicy(nonce));

    for (const [name, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
        expect(headers[name.toLowerCase()], name).toBe(value);
    }

    const scripts = openingTags(response.body, "script");
    const styles = openingTags(response.body, "style");

    expect(scripts.length, "the production document must contain renderer scripts").toBeGreaterThan(
        0,
    );

    for (const openingTag of [...scripts, ...styles]) {
        expect(nonceAttribute(openingTag), openingTag).toBe(nonce);
    }

    return { nonce, policy };
}

function builtChunk(prefix: string): string {
    const chunksDirectory = new URL("../../.output/public/_next/static/chunks/", import.meta.url);
    const matches = readdirSync(chunksDirectory).filter(
        (name) => name.startsWith(`${prefix}-`) && name.endsWith(".js"),
    );

    expect(matches, `expected exactly one built ${prefix} chunk`).toHaveLength(1);

    return `/_next/static/chunks/${matches[0]}`;
}

test("production scripts build and start the same Nitro output", () => {
    const packageJson = JSON.parse(
        readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
        build: "vite build",
        start: "node .output/server/index.mjs",
    });
});

test("Nitro documents receive fresh nonce headers and nonce-bearing markup", async ({
    baseURL,
    request,
}) => {
    test.skip(
        !useBuiltNitroServer,
        "requires PLAYWRIGHT_NITRO_SERVER=1 with a built Nitro base URL",
    );

    expect(baseURL).toBeDefined();

    const navigation = assertSecuredDocument(
        await playwrightResponse(await request.get("/", { headers: DOCUMENT_REQUEST_HEADERS })),
    );
    const wildcardAccept = assertSecuredDocument(
        await playwrightResponse(await request.get("/", { headers: { accept: "*/*" } })),
    );
    const absentAccept = assertSecuredDocument(await documentRequestWithoutAccept(baseURL ?? ""));

    expect(new Set([navigation.nonce, wildcardAccept.nonce, absentAccept.nonce]).size).toBe(3);
    expect(new Set([navigation.policy, wildcardAccept.policy, absentAccept.policy]).size).toBe(3);
});

test("API, RSC, manifest, and service-worker responses bypass document CSP", async ({
    request,
}) => {
    const excluded = [
        await request.get("/api/push/vapid-key", { headers: DOCUMENT_REQUEST_HEADERS }),
        await request.get("/manifest.webmanifest", { headers: DOCUMENT_REQUEST_HEADERS }),
        await request.get("/sw.js", { headers: DOCUMENT_REQUEST_HEADERS }),
        await request.get("/", { headers: { accept: "text/x-component", rsc: "1" } }),
    ];

    for (const response of excluded) {
        expect(response.headers()[CONTENT_SECURITY_POLICY.toLowerCase()]).toBeUndefined();
        expect(
            response.headers()[CONTENT_SECURITY_POLICY_REPORT_ONLY.toLowerCase()],
        ).toBeUndefined();
    }
});

test("production CSP enforces inline-script, event-handler, and Trusted Types boundaries", async ({
    page,
}) => {
    test.skip(
        !useBuiltNitroServer,
        "requires PLAYWRIGHT_NITRO_SERVER=1 with a built Nitro base URL",
    );

    await page.addInitScript(() => {
        const securityProbe = globalThis as typeof globalThis & {
            __securityPolicyViolations?: Array<{ effectiveDirective: string }>;
        };

        securityProbe.__securityPolicyViolations = [];
        addEventListener("securitypolicyviolation", (event) => {
            securityProbe.__securityPolicyViolations?.push({
                effectiveDirective: event.effectiveDirective,
            });
        });
    });
    await page.goto("/");
    await expect(page.locator("main")).toBeVisible();

    const baselineViolations = await page.evaluate(() => {
        const securityProbe = globalThis as typeof globalThis & {
            __securityPolicyViolations?: Array<{ effectiveDirective: string }>;
        };

        return securityProbe.__securityPolicyViolations ?? [];
    });

    expect(baselineViolations).toEqual([]);

    const result = await page.evaluate(async () => {
        const securityProbe = globalThis as typeof globalThis & {
            __cspInlineScriptExecuted?: boolean;
            __cspEventHandlerExecuted?: boolean;
            __securityPolicyViolations?: Array<{ effectiveDirective: string }>;
            trustedTypes?: {
                createPolicy(
                    name: string,
                    rules: { createScript(input: string): string },
                ): { createScript(input: string): unknown };
            };
        };
        const policy = securityProbe.trustedTypes?.createPolicy("subetha-matrix-html", {
            createScript(input) {
                return input;
            },
        });

        if (!policy) {
            throw new Error("Trusted Types policy factory was unavailable");
        }

        const inlineScript = document.createElement("script");
        let inlineScriptError = "";

        try {
            inlineScript.text = "globalThis.__cspInlineScriptExecuted = true;";
        } catch (error) {
            inlineScriptError = error instanceof TypeError ? error.message : String(error);
        }

        document.head.append(inlineScript);

        const eventHandler = document.createElement("button");

        eventHandler.setAttribute(
            "onclick",
            policy.createScript("globalThis.__cspEventHandlerExecuted = true;") as string,
        );
        document.body.append(eventHandler);
        eventHandler.click();

        let innerHtmlError = "";

        try {
            document.createElement("div").innerHTML = "<p>untrusted markup</p>";
        } catch (error) {
            innerHtmlError = error instanceof TypeError ? error.message : String(error);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        return {
            eventHandlerExecuted: securityProbe.__cspEventHandlerExecuted === true,
            inlineScriptExecuted: securityProbe.__cspInlineScriptExecuted === true,
            inlineScriptError,
            innerHtmlError,
            violations: securityProbe.__securityPolicyViolations ?? [],
        };
    });

    expect(result.inlineScriptExecuted).toBe(false);
    expect(result.inlineScriptError).not.toBe("");
    expect(result.eventHandlerExecuted).toBe(false);
    expect(result.innerHtmlError).not.toBe("");
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
    expect(result.violations.map(({ effectiveDirective }) => effectiveDirective)).toEqual(
        expect.arrayContaining(["script-src-attr", "require-trusted-types-for"]),
    );
    expect(
        result.violations.every(({ effectiveDirective }) =>
            ["script-src-attr", "require-trusted-types-for"].includes(effectiveDirective),
        ),
    ).toBe(true);
    await expect(page.locator("main")).toBeVisible();
});

test("production emoji picker uses a nonce-bearing, Trusted-Types-safe stylesheet", async ({
    page,
}) => {
    test.skip(
        !useBuiltNitroServer,
        "requires PLAYWRIGHT_NITRO_SERVER=1 with a built Nitro base URL",
    );

    const emojiChunk = builtChunk("EmojiPickerPanel");
    const frameworkChunk = builtChunk("framework");
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (message) => {
        if (message.type() === "error") {
            consoleErrors.push(message.text());
        }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
        const securityProbe = globalThis as typeof globalThis & {
            __securityPolicyViolations?: Array<Record<string, string>>;
        };

        securityProbe.__securityPolicyViolations = [];
        addEventListener("securitypolicyviolation", (event) => {
            securityProbe.__securityPolicyViolations?.push({
                blockedURI: event.blockedURI,
                effectiveDirective: event.effectiveDirective,
                sample: event.sample,
            });
        });
    });

    await page.goto("/");
    const expectedNonce = await page.evaluate(
        async ({ emojiModuleUrl, frameworkModuleUrl }) => {
            const [emojiModule, frameworkModule] = await Promise.all([
                import(emojiModuleUrl),
                import(frameworkModuleUrl),
            ]);

            type RuntimeModule = {
                createElement?: (...arguments_: unknown[]) => unknown;
                createRoot?: (container: Element) => {
                    render(node: unknown): void;
                };
            };

            const frameworkExports = Object.values(frameworkModule).flatMap((loadRuntimeModule) => {
                if (typeof loadRuntimeModule !== "function") {
                    return [];
                }

                try {
                    return [loadRuntimeModule() as RuntimeModule];
                } catch {
                    return [];
                }
            });
            const react = frameworkExports.find(
                (value) => typeof value?.createElement === "function",
            );
            const reactDomClient = frameworkExports.find(
                (value) => typeof value?.createRoot === "function",
            );
            const nonce = document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;

            if (!react?.createElement || !reactDomClient?.createRoot || !nonce) {
                throw new Error("production React runtime or document nonce was unavailable");
            }

            const mount = document.createElement("div");

            mount.id = "security-emoji-mount";
            document.body.append(mount);
            reactDomClient
                .createRoot(mount)
                .render(react.createElement(emojiModule.EmojiPickerPanel, { onSelect() {} }));

            return nonce;
        },
        { emojiModuleUrl: emojiChunk, frameworkModuleUrl: frameworkChunk },
    );

    await expect(page.locator("#security-emoji-mount .EmojiPickerReact")).toBeVisible();
    const runtime = await page.evaluate(() => {
        const securityProbe = globalThis as typeof globalThis & {
            __securityPolicyViolations?: Array<Record<string, string>>;
        };
        const style = document.querySelector<HTMLStyleElement>("#security-emoji-mount style");

        return {
            css: style?.textContent ?? "",
            nonce: style?.nonce ?? "",
            violations: securityProbe.__securityPolicyViolations ?? [],
        };
    });

    expect(runtime.nonce).toBe(expectedNonce);
    expect(runtime.css.length).toBeGreaterThan(10_000);
    expect(runtime.css).toContain(".EmojiPickerReact");
    expect(runtime.violations).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
});
