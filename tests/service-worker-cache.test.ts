import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { IDBFactory } from "fake-indexeddb";

const ORIGIN = "https://sub-etha.test";
const WORKER_SOURCE = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

interface WorkerRequest {
    destination: string;
    method: string;
    mode: string;
    url: string;
}

type FetchInput = Request | URL | WorkerRequest | string;
type FetchImplementation = (url: URL, input: FetchInput, init?: RequestInit) => Promise<Response>;

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
    private readonly rejectKeys: boolean;

    constructor(names: string[] = [], rejectedDeletes: string[] = [], rejectKeys = false) {
        this.names = new Set(names);
        this.rejectedDeletes = new Set(rejectedDeletes);
        this.rejectKeys = rejectKeys;
    }

    async delete(name: string): Promise<boolean> {
        this.deletedNames.push(name);

        if (this.rejectedDeletes.has(name)) {
            throw new Error(`Injected cache deletion failure for ${name}`);
        }

        return this.names.delete(name);
    }

    async keys(): Promise<string[]> {
        if (this.rejectKeys) {
            throw new Error("Injected cache enumeration failure");
        }

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

interface WorkerClient {
    type: "window";
    url: string;
    navigate: (url: string) => Promise<unknown>;
}

function createWorker(
    options: {
        cacheNames?: string[];
        cacheKeysFailure?: boolean;
        clients?: WorkerClient[];
        fetch?: FetchImplementation;
        indexedDB?: IDBFactory;
        matchAllFailure?: boolean;
        active?: object | null;
        rejectedCacheDeletes?: string[];
        skipWaiting?: () => Promise<void>;
    } = {},
) {
    const handlers = new Map<string, (event: Record<string, unknown>) => void>();
    const cacheStorage = new CacheStorageSpy(
        options.cacheNames,
        options.rejectedCacheDeletes,
        options.cacheKeysFailure,
    );
    const indexedDB = options.indexedDB ?? new IDBFactory();
    const clients = options.clients ?? [];
    const fetches: string[] = [];
    const fetchInits: RequestInit[] = [];
    let claims = 0;
    let matchAllCalls = 0;
    let skipWaitingCalls = 0;

    const workerFetch = async (input: FetchInput, init?: RequestInit) => {
        const url = inputUrl(input);

        fetches.push(url.href);

        if (init) {
            fetchInits.push(init);
        }

        return options.fetch
            ? options.fetch(url, input, init)
            : new Response(null, { status: 200 });
    };

    const worker = {
        addEventListener(type: string, handler: (event: Record<string, unknown>) => void) {
            handlers.set(type, handler);
        },
        clients: {
            async claim() {
                claims += 1;
            },
            async matchAll() {
                matchAllCalls += 1;

                if (options.matchAllFailure) {
                    throw new Error("Injected client enumeration failure");
                }

                return clients;
            },
        },
        location: { origin: ORIGIN },
        navigator: {},
        registration: { active: options.active ?? null },
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
        indexedDB,
        TextEncoder,
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
        fetchInits,
        indexedDB,
        matchAllCalls: () => matchAllCalls,
        skipWaitingCalls: () => skipWaitingCalls,
    };
}

async function settle(event: DispatchedEvent): Promise<Response | null> {
    const response = event.response ? await event.response : null;

    await Promise.all(event.waits);

    return response;
}

test("install records its lifecycle marker, skips waiting, and never writes app caches", async () => {
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
    });
    const install = worker.dispatch("install");

    assert.equal(install.handled, true);
    assert.equal(install.waits.length, 1);
    assert.equal(await settle(install), null);
    assert.equal(worker.skipWaitingCalls(), 1);
    assert.deepEqual(worker.fetches, []);
    assert.deepEqual(worker.cacheStorage.openedNames, []);
    assert.deepEqual(worker.cacheStorage.puts, []);
    assert.doesNotMatch(WORKER_SOURCE, /\bcaches\.open\b|\bcache\.put\b|\.addAll\(/);
});

test("a lifecycle marker write failure rejects installation before skipWaiting", async () => {
    const indexedDB = {
        open() {
            throw new Error("Injected lifecycle marker write failure");
        },
    } as unknown as IDBFactory;
    const worker = createWorker({ indexedDB });

    await assert.rejects(
        () => settle(worker.dispatch("install")),
        /lifecycle marker write failure/,
    );
    assert.equal(worker.skipWaitingCalls(), 0);
});

test("the lifecycle marker survives a worker global restart and first install does not enumerate clients", async () => {
    const indexedDB = new IDBFactory();
    const firstInstall = createWorker({ indexedDB });

    await settle(firstInstall.dispatch("install"));

    assert.equal(firstInstall.matchAllCalls(), 0);

    const client = {
        type: "window" as const,
        url: `${ORIGIN}/login`,
        navigate: async () => undefined,
    };
    const restartedWorker = createWorker({ indexedDB, active: {}, clients: [client] });

    await settle(restartedWorker.dispatch("activate"));

    assert.equal(restartedWorker.matchAllCalls(), 0);
    assert.equal(restartedWorker.claims(), 1);
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
    assert.equal(worker.fetchInits.length, 1);
    assert.equal(worker.fetchInits[0]?.cache, "no-store");
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

test("update activation navigates old same-origin windows after attempting every owned cache deletion", async () => {
    const indexedDB = new IDBFactory();
    const navigated: string[] = [];
    const clients = [
        {
            type: "window" as const,
            url: `${ORIGIN}/room/one`,
            navigate: async (url: string) => {
                navigated.push(url);
            },
        },
        {
            type: "window" as const,
            url: "https://accounts.example/login",
            navigate: async (url: string) => {
                navigated.push(url);
            },
        },
    ];
    const installingWorker = createWorker({ active: {}, indexedDB });

    await settle(installingWorker.dispatch("install"));

    const activatedWorker = createWorker({
        active: {},
        cacheNames: ["sub-etha-shell-v7", "sub-etha-static-v8", "unrelated-old-worker-cache"],
        clients,
        indexedDB,
        rejectedCacheDeletes: ["sub-etha-shell-v7"],
    });
    const activation = activatedWorker.dispatch("activate");

    assert.equal(activation.handled, true);
    assert.equal(activation.waits.length, 1);
    await settle(activation);
    assert.deepEqual(await activatedWorker.cacheStorage.keys(), [
        "sub-etha-shell-v7",
        "unrelated-old-worker-cache",
    ]);
    assert.deepEqual(activatedWorker.cacheStorage.deletedNames, [
        "sub-etha-shell-v7",
        "sub-etha-static-v8",
    ]);
    assert.equal(activatedWorker.claims(), 1);
    assert.deepEqual(navigated, [`${ORIGIN}/room/one`]);
    assert.deepEqual(activatedWorker.cacheStorage.openedNames, []);
    assert.deepEqual(activatedWorker.cacheStorage.puts, []);
});

test("cache enumeration failure is best effort while claim and navigation continue", async () => {
    const navigated: string[] = [];
    const client = {
        type: "window" as const,
        url: `${ORIGIN}/room/one`,
        navigate: async (url: string) => {
            navigated.push(url);
        },
    };
    const worker = createWorker({
        active: {},
        cacheKeysFailure: true,
        clients: [client],
    });

    await settle(worker.dispatch("install"));
    await settle(worker.dispatch("activate"));

    assert.equal(worker.claims(), 1);
    assert.deepEqual(navigated, [client.url]);
});

test("client enumeration failure rejects activation before claim", async () => {
    const worker = createWorker({ active: {}, matchAllFailure: true });

    await settle(worker.dispatch("install"));

    await assert.rejects(() => settle(worker.dispatch("activate")), /client enumeration failure/);
    assert.equal(worker.claims(), 0);
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
            "Cache-Control": "no-store, must-revalidate",
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
