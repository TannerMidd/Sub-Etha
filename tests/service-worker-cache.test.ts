import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const ORIGIN = "https://sub-etha.test";
const WORKER_SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

interface WorkerRequest {
    destination: string;
    method: string;
    mode: string;
    url: string;
}

type FetchInput = Request | URL | WorkerRequest | string;
type FetchImplementation = (url: URL, input: FetchInput) => Promise<Response>;

function inputUrl(input: FetchInput): URL {
    if (typeof input === "string") {
        return new URL(input, ORIGIN);
    }

    if (input instanceof URL) {
        return input;
    }

    return new URL(input.url, ORIGIN);
}

function request(path: string, overrides: Partial<WorkerRequest> = {}): WorkerRequest {
    return {
        destination: "script",
        method: "GET",
        mode: "cors",
        url: new URL(path, ORIGIN).href,
        ...overrides,
    };
}

class CacheStorageSpy {
    readonly deletedNames: string[] = [];
    readonly openedNames: string[] = [];
    readonly puts: string[] = [];
    private readonly names: Set<string>;
    private readonly rejectedDeletes: Set<string>;

    constructor(names: string[] = [], rejectedDeletes: string[] = []) {
        this.names = new Set(names);
        this.rejectedDeletes = new Set(rejectedDeletes);
    }

    async delete(name: string): Promise<boolean> {
        this.deletedNames.push(name);

        if (this.rejectedDeletes.has(name)) {
            throw new Error(`Injected cache deletion failure for ${name}`);
        }

        return this.names.delete(name);
    }

    async keys(): Promise<string[]> {
        return [...this.names];
    }

    async open(name: string) {
        this.openedNames.push(name);

        return {
            put: async (input: FetchInput) => {
                this.puts.push(inputUrl(input).href);
            },
        };
    }
}

interface DispatchedEvent {
    handled: boolean;
    response: Promise<Response> | null;
    waits: Promise<unknown>[];
}

function createWorker(
    options: {
        cacheNames?: string[];
        fetch?: FetchImplementation;
        rejectedCacheDeletes?: string[];
        skipWaiting?: () => Promise<void>;
    } = {},
) {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const cacheStorage = new CacheStorageSpy(options.cacheNames, options.rejectedCacheDeletes);
    const fetches: string[] = [];
    let claims = 0;
    let skipWaitingCalls = 0;

    const workerFetch = async (input: FetchInput) => {
        const url = inputUrl(input);

        fetches.push(url.href);

        return options.fetch ? options.fetch(url, input) : new Response(null, { status: 200 });
    };

    const worker = {
        addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
            handlers.set(type, handler);
        },
        clients: {
            async claim() {
                claims += 1;
            },
        },
        location: { origin: ORIGIN },
        navigator: {},
        registration: {},
        async skipWaiting() {
            skipWaitingCalls += 1;
            await options.skipWaiting?.();
        },
    };

    vm.runInNewContext(WORKER_SOURCE, {
        Response,
        URL,
        atob,
        caches: cacheStorage,
        fetch: workerFetch,
        self: worker,
    });

    const dispatch = (type: string, details: Record<string, unknown> = {}): DispatchedEvent => {
        const handler = handlers.get(type);
        const waits: Promise<unknown>[] = [];
        let response: Promise<Response> | null = null;

        handler?.({
            ...details,
            respondWith(value: Promise<Response> | Response) {
                response = Promise.resolve(value);
            },
            waitUntil(value: Promise<unknown>) {
                waits.push(value);
            },
        });

        return { handled: Boolean(handler), response, waits };
    };

    return {
        cacheStorage,
        claims: () => claims,
        dispatch,
        fetches,
        skipWaitingCalls: () => skipWaitingCalls,
    };
}

async function settle(event: DispatchedEvent): Promise<Response | null> {
    const response = event.response ? await event.response : null;

    await Promise.all(event.waits);

    return response;
}

test("install is cache-free and cannot be blocked by optional asset failures", async () => {
    let releaseSkipWaiting: (() => void) | undefined;
    const skipWaitingGate = new Promise<void>((resolve) => {
        releaseSkipWaiting = resolve;
    });
    const worker = createWorker({
        fetch: async (url) => {
            if (url.pathname.endsWith(".png")) {
                return new Response("<!doctype html><script>unexpected()</script>", {
                    status: 200,
                    headers: { "Content-Type": "text/html" },
                });
            }

            throw new TypeError("optional font unavailable");
        },
        skipWaiting: () => skipWaitingGate,
    });
    const install = worker.dispatch("install");

    assert.equal(install.handled, true);
    assert.equal(install.waits.length, 1);
    assert.equal(worker.skipWaitingCalls(), 1);

    let installFinished = false;

    void install.waits[0].then(() => {
        installFinished = true;
    });
    await Promise.resolve();
    assert.equal(installFinished, false);

    releaseSkipWaiting?.();
    assert.equal(await settle(install), null);
    assert.equal(installFinished, true);
    assert.deepEqual(worker.fetches, []);
    assert.deepEqual(worker.cacheStorage.openedNames, []);
    assert.deepEqual(worker.cacheStorage.puts, []);
    assert.doesNotMatch(WORKER_SOURCE, /\bcaches\.open\b|\bcache\.put\b|\.addAll\(/);
});

test("online navigation HTML is returned from network but never stored", async () => {
    const executableHtml = "<!doctype html><script>online()</script>";
    const worker = createWorker({
        fetch: async () =>
            new Response(executableHtml, {
                status: 200,
                headers: { "Content-Type": "text/html; charset=utf-8" },
            }),
    });
    const navigation = worker.dispatch("fetch", {
        request: request("/room/one", { destination: "document", mode: "navigate" }),
    });
    const response = await settle(navigation);

    assert.equal(await response?.text(), executableHtml);
    assert.equal(worker.fetches.length, 1);
    assert.deepEqual(worker.cacheStorage.openedNames, []);
    assert.deepEqual(worker.cacheStorage.puts, []);
});

test("failed navigation receives a newly constructed inert response", async () => {
    const worker = createWorker({
        fetch: async () => {
            throw new TypeError("offline");
        },
    });
    const first = await settle(
        worker.dispatch("fetch", {
            request: request("/room/one", { destination: "document", mode: "navigate" }),
        }),
    );
    const second = await settle(
        worker.dispatch("fetch", {
            request: request("/room/two", { destination: "document", mode: "navigate" }),
        }),
    );

    assert.notEqual(first, second);
    assert.equal(first?.status, 503);
    assert.equal(first?.headers.get("Cache-Control"), "no-store");
    assert.equal(first?.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(first?.headers.get("X-Content-Type-Options"), "nosniff");
    assert.doesNotMatch(await first!.text(), /<script\b/i);

    const csp = first?.headers.get("Content-Security-Policy") ?? "";

    for (const directive of [
        "default-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
    ]) {
        assert.ok(csp.includes(directive), `missing offline CSP directive: ${directive}`);
    }

    assert.deepEqual(worker.cacheStorage.openedNames, []);
    assert.deepEqual(worker.cacheStorage.puts, []);
});

test("the worker never intercepts or caches non-navigation requests", () => {
    const worker = createWorker();
    const paths = [
        "/manifest.webmanifest",
        "/icon-192.png",
        "/fonts/commissioner-variable.ttf",
        "/_next/static/chunks/app.js",
        "/api/data.js",
        "/_matrix/client.css",
        "/_vinext/runtime.js",
        "/sw.js",
        "/arbitrary.png",
    ];

    for (const path of paths) {
        const event = worker.dispatch("fetch", { request: request(path) });

        assert.equal(event.response, null, `${path} should not be intercepted`);
        assert.deepEqual(event.waits, []);
    }

    assert.deepEqual(worker.fetches, []);
    assert.deepEqual(worker.cacheStorage.openedNames, []);
    assert.deepEqual(worker.cacheStorage.puts, []);
});

test("activation claims clients after attempting every owned cache deletion", async () => {
    const worker = createWorker({
        cacheNames: ["sub-etha-shell-v7", "sub-etha-static-v8", "unrelated-old-worker-cache"],
        rejectedCacheDeletes: ["sub-etha-shell-v7"],
    });
    const activation = worker.dispatch("activate");

    assert.equal(activation.handled, true);
    assert.equal(activation.waits.length, 1);
    await settle(activation);
    assert.deepEqual(await worker.cacheStorage.keys(), [
        "sub-etha-shell-v7",
        "unrelated-old-worker-cache",
    ]);
    assert.deepEqual(worker.cacheStorage.deletedNames, ["sub-etha-shell-v7", "sub-etha-static-v8"]);
    assert.equal(worker.claims(), 1);
    assert.deepEqual(worker.cacheStorage.openedNames, []);
    assert.deepEqual(worker.cacheStorage.puts, []);
});

test("registration bypasses HTTP cache and Vercel serves fixed worker headers", () => {
    const registrationSource = readFileSync(
        new URL("../lib/matrix/notifications.ts", import.meta.url),
        "utf8",
    );

    assert.match(registrationSource, /const scriptUrl = trustedServiceWorkerScriptUrl\(\)/);
    assert.match(
        registrationSource,
        /serviceWorker\.register\(scriptUrl as unknown as string,[\s\S]*?scope: "\/",[\s\S]*?updateViaCache: "none",?[\s\S]*?\}\)/,
    );

    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
        headers: Array<{
            headers: Array<{ key: string; value: string }>;
            source: string;
        }>;
        rewrites: Array<{ destination: string; source: string }>;
    };
    const workerRules = vercel.headers.filter(({ source }) => source === "/sw.js");

    assert.equal(workerRules.length, 1);
    assert.deepEqual(
        Object.fromEntries(workerRules[0].headers.map(({ key, value }) => [key, value])),
        {
            "Cache-Control": "public, max-age=0, must-revalidate",
            "Content-Security-Policy":
                "default-src 'none'; script-src 'self'; connect-src 'self'; object-src 'none'",
            "Content-Type": "application/javascript; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
        },
    );
    assert.ok(
        vercel.rewrites.some(
            ({ destination, source }) =>
                source === "/_matrix/push/v1/notify" && destination === "/api/matrix-push-notify",
        ),
    );
});
