import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import ts from "typescript";
import { sanitizeMatrixHtml } from "../lib/matrix/trusted-html";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOMPURIFY_SCRIPT_PATH = `${PROJECT_ROOT}/node_modules/dompurify/dist/purify.js`;

let browser: Browser;
let browserModuleSource: string;

test.before(async () => {
    const helperSource = await readFile(`${PROJECT_ROOT}/lib/matrix/trusted-html.ts`, "utf8");
    const transpiled = ts.transpileModule(helperSource, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;

    browserModuleSource = transpiled.replace(
        'import DOMPurify from "dompurify";',
        "const DOMPurify = globalThis.DOMPurify;",
    );
    assert.doesNotMatch(browserModuleSource, /from ["']dompurify["']/);
    browser = await chromium.launch({ headless: true });
});

test.after(async () => {
    await browser?.close();
});

async function openTestPage(): Promise<Page> {
    const page = await browser.newPage();

    await page.goto("about:blank");

    return page;
}

test("Trusted Types policy and dependency patches stay narrow and fail-closed", async () => {
    const [
        helperSource,
        timelineSource,
        emojiPanelSource,
        packageSource,
        lockSource,
        patcherSource,
    ] = await Promise.all([
        readFile(`${PROJECT_ROOT}/lib/matrix/trusted-html.ts`, "utf8"),
        readFile(`${PROJECT_ROOT}/app/components/Timeline.tsx`, "utf8"),
        readFile(`${PROJECT_ROOT}/app/components/EmojiPickerPanel.tsx`, "utf8"),
        readFile(`${PROJECT_ROOT}/package.json`, "utf8"),
        readFile(`${PROJECT_ROOT}/package-lock.json`, "utf8"),
        readFile(`${PROJECT_ROOT}/scripts/apply-security-patches.mjs`, "utf8"),
    ]);
    const packageManifest = JSON.parse(packageSource) as {
        dependencies: Record<string, string>;
        scripts: Record<string, string>;
        devDependencies: Record<string, string>;
    };
    const packageLock = JSON.parse(lockSource) as {
        packages: Record<string, { dependencies?: Record<string, string>; version?: string }>;
    };

    assert.equal(packageManifest.devDependencies["patch-package"], undefined);
    assert.equal(packageManifest.dependencies["emoji-picker-react"], "4.19.1");
    assert.equal(packageManifest.dependencies.flairup, "1.0.0");
    assert.equal(packageManifest.scripts.postinstall, "node scripts/apply-security-patches.mjs");
    assert.equal(packageManifest.scripts.prebuild, "node scripts/apply-security-patches.mjs");
    assert.equal(packageLock.packages[""]?.dependencies?.["emoji-picker-react"], "4.19.1");
    assert.equal(packageLock.packages[""]?.dependencies?.flairup, "1.0.0");
    assert.equal(packageLock.packages["node_modules/flairup"]?.version, "1.0.0");
    assert.equal(packageLock.packages["node_modules/emoji-picker-react"]?.version, "4.19.1");
    assert.equal(packageLock.packages["node_modules/patch-package"], undefined);
    assert.equal((helperSource.match(/\.createPolicy\(/g) ?? []).length, 1);
    assert.match(helperSource, /TRUSTED_HTML_POLICY_NAME = "subetha-matrix-html"/);
    assert.match(helperSource, /RETURN_TRUSTED_TYPE: false/);
    assert.match(helperSource, /TRUSTED_TYPES_POLICY: null/);
    assert.doesNotMatch(helperSource, /createPolicy\(["']default["']/);
    assert.match(timelineSource, /dangerouslySetInnerHTML=\{\{ __html: html \}\}/);
    assert.match(emojiPanelSource, /"script\[nonce\], style\[nonce\]"/);
    assert.match(emojiPanelSource, /nonce=\{nonce\}/);

    assert.match(patcherSource, /name: "flairup",\s+version: "1\.0\.0"/);
    assert.match(patcherSource, /name: "emoji-picker-react",\s+version: "4\.19\.1"/);
    assert.match(patcherSource, /sourceHash !== target\.pristineSha256/);
    assert.match(patcherSource, /sourceHash === target\.patchedSha256/);
    assert.match(patcherSource, /await rename\(temporaryPath, path\)/);
    assert.doesNotMatch(patcherSource, /patch-package/);

    const installedTargets = [
        {
            path: `${PROJECT_ROOT}/node_modules/flairup/dist/esm/index.js`,
            sha256: "00d6688a54f001f1883f4efa5825cd409abc8074c78c3ddccb96888bd3380053",
        },
        {
            path: `${PROJECT_ROOT}/node_modules/flairup/dist/index.js`,
            sha256: "33c20cd50e736a210377516d9fff03aba598532d4f7d3dff57699193158e69fb",
        },
    ];

    for (const installedTarget of installedTargets) {
        const installedBytes = await readFile(installedTarget.path);
        const installedSource = installedBytes.toString("utf8");
        const nonceLookup = installedSource.indexOf(
            'document.querySelector("script[nonce], style[nonce]")',
        );
        const nonceCopy = installedSource.indexOf("styleTag.nonce = nonceSource.nonce");
        const append = installedSource.indexOf("appendChild(styleTag)");

        assert.equal(
            createHash("sha256").update(installedBytes).digest("hex"),
            installedTarget.sha256,
        );
        assert.doesNotMatch(installedSource, /styleTag\.innerHTML/);
        assert.match(installedSource, /styleTag\.textContent = this\.style/);
        assert.ok(
            nonceLookup >= 0,
            `${installedTarget.path} must find a same-document nonce source`,
        );
        assert.ok(
            nonceCopy > nonceLookup,
            `${installedTarget.path} must copy the nonce via .nonce`,
        );
        assert.ok(
            append > nonceCopy,
            `${installedTarget.path} must copy the nonce before appending`,
        );
    }

    const installedEmojiTargets = [
        {
            path: `${PROJECT_ROOT}/node_modules/emoji-picker-react/dist/emoji-picker-react.esm.js`,
            sha256: "6b84be22277d56e7db828aaeacb7d4a49801b8d943c44a0070ff2101c2d4ddb3",
            textContent: "styleTag.textContent = stylesheet.getStyle();",
        },
        {
            path: `${PROJECT_ROOT}/node_modules/emoji-picker-react/dist/emoji-picker-react.cjs.development.js`,
            sha256: "7993639e30116728225e46b557d06ec044bb8c175be01fd213b36861da7cd167",
            textContent: "styleTag.textContent = stylesheet.getStyle();",
        },
        {
            path: `${PROJECT_ROOT}/node_modules/emoji-picker-react/dist/emoji-picker-react.cjs.production.min.js`,
            sha256: "0c3c58eea0a8111776e00b6a7fbddcc31d870b464b7b445aa2dd6816bc1ec27e",
            textContent: "f.textContent=c.getStyle()",
        },
    ];

    for (const installedTarget of installedEmojiTargets) {
        const installedBytes = await readFile(installedTarget.path);
        const installedSource = installedBytes.toString("utf8");

        assert.equal(
            createHash("sha256").update(installedBytes).digest("hex"),
            installedTarget.sha256,
        );
        assert.doesNotMatch(
            installedSource,
            /dangerouslySetInnerHTML:\s*\{\s*__html:\s*(?:stylesheet|c)\.getStyle\(\)/,
        );
        assert.ok(installedSource.includes(installedTarget.textContent));
    }
});

test("SSR sanitization fails closed without throwing", () => {
    assert.equal(sanitizeMatrixHtml('<strong onclick="alert(1)">unsafe</strong>'), "");
});

test("browsers without Trusted Types receive the DOMPurify-sanitized string", async () => {
    const page = await openTestPage();
    const input = [
        '<mx-reply><blockquote><a href="https://matrix.to/#/$event">reply</a></blockquote></mx-reply>',
        '<p data-mx-color="#112233" onclick="alert(1)"><strong>Safe</strong>',
        '<a href="javascript:alert(1)">bad</a>',
        '<a href="https://example.org/path" title="allowed">web</a>',
        '<a href="mailto:crew@example.org">mail</a>',
        '<a href="/relative">relative</a><img src="https://example.org/a.png">',
        "<script>alert(1)</script></p>",
    ].join("");

    try {
        await page.evaluate(() => {
            Object.defineProperty(globalThis, "trustedTypes", {
                configurable: true,
                value: undefined,
            });
        });
        await page.addScriptTag({ path: DOMPURIFY_SCRIPT_PATH });
        const result = await page.evaluate(
            async ({ inputHtml, moduleSource }) => {
                const moduleUrl = URL.createObjectURL(
                    new Blob([moduleSource], { type: "text/javascript" }),
                );
                const trustedHtmlModule = await import(moduleUrl);
                const output = trustedHtmlModule.sanitizeMatrixHtml(inputHtml);

                URL.revokeObjectURL(moduleUrl);

                return { output, type: typeof output };
            },
            {
                inputHtml: input,
                moduleSource: browserModuleSource,
            },
        );

        assert.equal(result.type, "string");
        assert.match(result.output, /<strong>Safe<\/strong>/);
        assert.match(result.output, /data-mx-color="#112233"/);
        assert.match(result.output, /href="https:\/\/example\.org\/path"/);
        assert.match(result.output, /href="mailto:crew@example\.org"/);
        assert.doesNotMatch(result.output, /mx-reply|onclick|javascript:|<img|<script|alert\(1\)/i);
        assert.match(result.output, /<a>relative<\/a>/);
    } finally {
        await page.close();
    }
});

test("the named policy sanitizes raw input and is initialized once", async () => {
    const page = await openTestPage();
    const rawInput = "<p><strong>safe</strong><script>alert(1)</script></p>";

    try {
        await page.evaluate(() => {
            const policyNames: string[] = [];
            const policyInputs: string[] = [];

            Object.assign(globalThis, { __policyNames: policyNames, __policyInputs: policyInputs });
            Object.defineProperty(globalThis, "trustedTypes", {
                configurable: true,
                value: {
                    createPolicy(name: string, rules: { createHTML(input: string): string }) {
                        policyNames.push(name);

                        return {
                            name,
                            createHTML(input: string) {
                                policyInputs.push(input);

                                return { trustedHtml: rules.createHTML(input) };
                            },
                        };
                    },
                },
            });
        });
        await page.addScriptTag({ path: DOMPURIFY_SCRIPT_PATH });
        const result = await page.evaluate(
            async ({ inputHtml, moduleSource }) => {
                const moduleUrl = URL.createObjectURL(
                    new Blob([moduleSource], { type: "text/javascript" }),
                );
                const trustedHtmlModule = await import(moduleUrl);
                const first = trustedHtmlModule.sanitizeMatrixHtml(inputHtml) as {
                    trustedHtml: string;
                };
                const second = trustedHtmlModule.sanitizeMatrixHtml("<em>second</em>") as {
                    trustedHtml: string;
                };
                const stored = globalThis as typeof globalThis & {
                    __policyInputs: string[];
                    __policyNames: string[];
                };

                URL.revokeObjectURL(moduleUrl);

                return {
                    first: first.trustedHtml,
                    policyInputs: stored.__policyInputs,
                    policyNames: stored.__policyNames,
                    second: second.trustedHtml,
                };
            },
            {
                inputHtml: rawInput,
                moduleSource: browserModuleSource,
            },
        );

        assert.deepEqual(result.policyNames, ["subetha-matrix-html"]);
        assert.deepEqual(result.policyInputs, [rawInput, "<em>second</em>"]);
        assert.equal(result.first, "<p><strong>safe</strong></p>");
        assert.equal(result.second, "<em>second</em>");
    } finally {
        await page.close();
    }
});

test("a duplicate-policy exception falls back to sanitized strings", async () => {
    const page = await openTestPage();

    try {
        await page.evaluate(() => {
            Object.assign(globalThis, { __createAttempts: 0 });
            Object.defineProperty(globalThis, "trustedTypes", {
                configurable: true,
                value: {
                    createPolicy() {
                        const stored = globalThis as typeof globalThis & {
                            __createAttempts: number;
                        };

                        stored.__createAttempts += 1;

                        throw new TypeError("Policy already exists");
                    },
                },
            });
        });
        await page.addScriptTag({ path: DOMPURIFY_SCRIPT_PATH });
        const result = await page.evaluate(
            async ({ moduleSource }) => {
                const moduleUrl = URL.createObjectURL(
                    new Blob([moduleSource], { type: "text/javascript" }),
                );
                const trustedHtmlModule = await import(moduleUrl);
                const first = trustedHtmlModule.sanitizeMatrixHtml(
                    "<strong>safe</strong><script>alert(1)</script>",
                );
                const second = trustedHtmlModule.sanitizeMatrixHtml(
                    '<em onclick="alert(2)">again</em>',
                );
                const { __createAttempts: createAttempts } = globalThis as typeof globalThis & {
                    __createAttempts: number;
                };

                URL.revokeObjectURL(moduleUrl);

                return { createAttempts, first, second };
            },
            { moduleSource: browserModuleSource },
        );

        assert.equal(result.createAttempts, 1);
        assert.equal(result.first, "<strong>safe</strong>");
        assert.equal(result.second, "<em>again</em>");
    } finally {
        await page.close();
    }
});
