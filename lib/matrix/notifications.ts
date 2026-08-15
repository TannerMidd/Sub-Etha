import type { MatrixService } from "./client";
import { randomBase64Url } from "./session-store";
import type { PushState } from "./types";
import { trustedServiceWorkerScriptUrl } from "../security/trusted-script-url";

const LEGACY_PUSH_KEY_STORAGE = "sub-etha-push-key";
const PUSH_DELIVERY_KEY_STORAGE = "sub-etha-push-delivery-key";
const PUSH_MANAGEMENT_KEY_STORAGE = "sub-etha-push-management-key";
const PUSH_GENERATION_STORAGE = "sub-etha-push-generation";
const PUSH_ENDPOINT_STORAGE = "sub-etha-push-endpoint";
const PUSH_CLEANUP_STORAGE = "sub-etha-push-cleanup-v1";
const PUSH_FALLBACK_CLEANUP_STORAGE = "sub-etha-push-fallback-cleanup-v1";
const PUSH_CLEANUP_INTENT_STORAGE = "sub-etha-push-cleanup-intent-v1";
const ABANDONED_MATRIX_PUSHER_WARNING_STORAGE = "sub-etha-matrix-pusher-abandoned-warning-v1";
const PUSH_DATABASE = "sub-etha-push";
const PUSH_DATABASE_VERSION = 1;
const PUSH_SETTINGS_STORE = "settings";
const PUSH_CONFIG_KEY = "config";
const PUSH_LIFECYCLE_LOCK = "sub-etha-push-lifecycle";
const PUSH_LIFECYCLE_EPOCH_STORAGE = "sub-etha-push-lifecycle-epoch";
const PUSH_APP_ID = "chat.subetha.pwa";
const LEGACY_PUSH_HOST_SUFFIX = ".chatgpt.site";
const PUSH_CONFIRMATION_TIMEOUT_MS = 15_000;
const PUSH_CLEANUP_TIMEOUT_MS = 5_000;
const SUPPORTED_SERVICE_WORKER_PROTOCOL_VERSION = 2;
const SERVICE_WORKER_UPDATE_REQUIRED_ERROR =
    "This app requires a service-worker update before push notifications can be changed.";

interface PushCredentials {
    deliveryKey: string;
    managementKey: string;
    generation: string;
    legacyGeneration?: boolean;
}

interface PendingPushCleanup {
    version: 1;
    cleanupId: string;
    generation: string | null;
    deliveryKey: string | null;
    managementKey: string | null;
    endpoint: string | null;
    gatewayDone: boolean;
    pusherDone: boolean;
    allowPusherAbandonment: boolean;
    subscriptionDone: boolean;
    workerDone: boolean;
    notificationsDone: boolean;
    badgeDone: boolean;
    additionalTargets?: PushCleanupTarget[];
}

interface PushCleanupTarget {
    deliveryKey: string;
    managementKey: string;
    gatewayDone: boolean;
    pusherDone: boolean;
}

interface FallbackPushCleanupTarget {
    deliveryKey: string;
    managementKey: string;
    generation: string;
    endpoint: string;
    workerMayBeConfigured: boolean;
}

interface FallbackPushCleanup {
    version: 1;
    targets: FallbackPushCleanupTarget[];
}

type PushSetupCleanupQueueResult = "primary" | "fallback" | "none";

interface WorkerPushConfig {
    deliveryKey: string;
    managementKey: string;
    generation: string | null;
    legacyGeneration: boolean;
}

interface ServiceWorkerPushSession {
    registration: ServiceWorkerRegistration;
    worker: ServiceWorker;
    config: WorkerPushConfig | null;
}

type OrphanedPushDatabaseState = { exists: false } | { exists: true; credentials: PushCredentials };

interface PushConfigMessageResult {
    ok: true;
    protocolVersion: number;
    cleared?: boolean;
    config?: WorkerPushConfig | null;
}

export interface PushCleanupResult {
    complete: boolean;
    durable: boolean;
    matrixPusherAbandoned?: boolean;
    error?: string;
}

export interface PushCleanupOptions {
    abandonMatrixPusherAfterGatewayCleanup?: boolean;
}

export const ABANDONED_MATRIX_PUSHER_WARNING =
    "Local browser and notification-relay cleanup finished, but this browser could not confirm removal of its Matrix notification pusher. Remove or revoke this device from another trusted Matrix client.";

let abandonedMatrixPusherWarningFallback = false;

function hasAbandonedMatrixPusherWarning(): boolean {
    if (abandonedMatrixPusherWarningFallback) {
        return true;
    }

    try {
        return localStorage.getItem(ABANDONED_MATRIX_PUSHER_WARNING_STORAGE) === "1";
    } catch {
        return false;
    }
}

function persistAbandonedMatrixPusherWarning(): boolean {
    try {
        localStorage.setItem(ABANDONED_MATRIX_PUSHER_WARNING_STORAGE, "1");
        abandonedMatrixPusherWarningFallback = false;

        return true;
    } catch {
        // Keep the warning visible for this document, but do not complete cleanup: the durable
        // cleanup journal must survive so a reload can retry recording the warning.
        abandonedMatrixPusherWarningFallback = true;

        return false;
    }
}

export function readAbandonedMatrixPusherWarning(): string | null {
    return hasAbandonedMatrixPusherWarning() ? ABANDONED_MATRIX_PUSHER_WARNING : null;
}

export function clearAbandonedMatrixPusherWarning(): void {
    abandonedMatrixPusherWarningFallback = false;

    try {
        localStorage.removeItem(ABANDONED_MATRIX_PUSHER_WARNING_STORAGE);
    } catch {
        // The in-memory warning is acknowledged. A failed durable acknowledgement leaves the
        // storage marker intact so it will be shown again after a reload rather than lost.
    }
}

function abandonedMatrixPusherResult(): Pick<PushCleanupResult, "matrixPusherAbandoned"> {
    return hasAbandonedMatrixPusherWarning() ? { matrixPusherAbandoned: true } : {};
}

export function decodeApplicationServerKey(value: string): Uint8Array {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function applicationServerKey(value: string): ArrayBuffer {
    const bytes = decodeApplicationServerKey(value);

    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function readPushState(): PushState {
    const supported =
        "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

    return {
        supported,
        enabled: false,
        permission: supported ? Notification.permission : "unsupported",
        checking: supported,
    };
}

export function totalUnreadCount(rooms: ReadonlyArray<{ unread: number }>): number {
    return rooms.reduce(
        (total, room) =>
            total + (Number.isFinite(room.unread) ? Math.max(0, Math.trunc(room.unread)) : 0),
        0,
    );
}

export async function syncAppBadge(unread: number): Promise<void> {
    const count = Number.isFinite(unread) ? Math.max(0, Math.trunc(unread)) : 0;

    if (count > 0) {
        if ("setAppBadge" in navigator) {
            await navigator.setAppBadge(count).catch(() => undefined);
        }

        return;
    }

    if ("clearAppBadge" in navigator) {
        await navigator.clearAppBadge().catch(() => undefined);
    }
}

export async function dismissRoomNotification(roomId: string): Promise<void> {
    if (!("serviceWorker" in navigator) || !roomId) {
        return;
    }

    const registration = await navigator.serviceWorker.ready.catch(() => null);
    const worker = registration?.active ?? navigator.serviceWorker.controller;

    worker?.postMessage({ type: "DISMISS_ROOM_NOTIFICATION", roomId });
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!("serviceWorker" in navigator)) {
        return null;
    }

    const scriptUrl = trustedServiceWorkerScriptUrl();

    if (!scriptUrl) {
        return null;
    }

    // TypeScript's DOM signature has not yet adopted TrustedScriptURL, but browsers do.
    await navigator.serviceWorker.register(scriptUrl as unknown as string, {
        scope: "/",
        updateViaCache: "none",
    });

    return navigator.serviceWorker.ready;
}

async function gatewayRequest(
    method: "POST" | "DELETE",
    body: Record<string, unknown>,
    path = "/api/push/subscriptions",
    signal?: AbortSignal,
): Promise<Record<string, unknown>> {
    const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        const message = payload?.error;

        throw new Error(message || `Push gateway returned ${response.status}.`);
    }

    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function publicVapidKey(): Promise<string> {
    const response = await fetch("/api/push/vapid-key", {
        headers: { Accept: "application/json" },
        cache: "no-store",
    });

    if (!response.ok) {
        throw new Error("Closed-app notifications are not configured on this deployment yet.");
    }

    const { publicKey } = (await response.json()) as { publicKey?: unknown };

    if (typeof publicKey !== "string" || !publicKey) {
        throw new Error("The push gateway returned an invalid application key.");
    }

    return publicKey;
}

export function pushSubscriptionNeedsRepair(
    subscription: Pick<PushSubscription, "options"> | null,
    publicKey: string,
): boolean {
    if (!subscription) {
        return true;
    }

    const current = subscription.options.applicationServerKey;

    if (!current) {
        return true;
    }

    const currentBytes = new Uint8Array(current);
    const expectedBytes = decodeApplicationServerKey(publicKey);

    return (
        currentBytes.length !== expectedBytes.length ||
        currentBytes.some((value, index) => value !== expectedBytes[index])
    );
}

async function bounded<T>(label: string, operation: () => Promise<T>): Promise<T> {
    let timeout = 0;

    try {
        return await Promise.race([
            operation(),
            new Promise<T>((_resolve, reject) => {
                timeout = window.setTimeout(
                    () => reject(new Error(`${label} timed out.`)),
                    PUSH_CLEANUP_TIMEOUT_MS,
                );
            }),
        ]);
    } finally {
        window.clearTimeout(timeout);
    }
}

async function withPushLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!("locks" in navigator)) {
        throw new Error("Secure notification changes require Web Locks support.");
    }

    const controller = new AbortController();
    let acquired = false;
    const timeout = window.setTimeout(() => {
        if (!acquired) {
            controller.abort(new Error("Notification cleanup lock timed out."));
        }
    }, PUSH_CLEANUP_TIMEOUT_MS);

    try {
        return await navigator.locks.request(
            PUSH_LIFECYCLE_LOCK,
            { mode: "exclusive", signal: controller.signal },
            async () => {
                acquired = true;
                window.clearTimeout(timeout);

                return operation();
            },
        );
    } finally {
        window.clearTimeout(timeout);
    }
}

async function sendPushConfigMessage(
    worker: ServiceWorker,
    message: Record<string, unknown>,
): Promise<PushConfigMessageResult> {
    const channel = new MessageChannel();

    try {
        return await bounded(
            "Service-worker push cleanup",
            () =>
                new Promise<PushConfigMessageResult>((resolve, reject) => {
                    channel.port1.onmessage = (event) => {
                        if (
                            event.data?.protocolVersion !==
                            SUPPORTED_SERVICE_WORKER_PROTOCOL_VERSION
                        ) {
                            reject(new Error(SERVICE_WORKER_UPDATE_REQUIRED_ERROR));

                            return;
                        }

                        if (event.data?.ok === true) {
                            const rawConfig = event.data.config;
                            const config: WorkerPushConfig | null | undefined =
                                rawConfig === null
                                    ? null
                                    : rawConfig &&
                                        typeof rawConfig.deliveryKey === "string" &&
                                        typeof rawConfig.managementKey === "string" &&
                                        (rawConfig.generation === null ||
                                            typeof rawConfig.generation === "string") &&
                                        (rawConfig.legacyGeneration === undefined ||
                                            typeof rawConfig.legacyGeneration === "boolean")
                                      ? {
                                            deliveryKey: rawConfig.deliveryKey,
                                            managementKey: rawConfig.managementKey,
                                            generation: rawConfig.generation,
                                            legacyGeneration: rawConfig.legacyGeneration === true,
                                        }
                                      : undefined;

                            resolve({
                                ok: true,
                                protocolVersion: SUPPORTED_SERVICE_WORKER_PROTOCOL_VERSION,
                                ...(typeof event.data.cleared === "boolean"
                                    ? { cleared: event.data.cleared }
                                    : {}),
                                ...(config !== undefined ? { config } : {}),
                            });
                        } else {
                            reject(
                                new Error(
                                    "The service worker rejected the push configuration change.",
                                ),
                            );
                        }
                    };

                    channel.port1.onmessageerror = () => {
                        reject(
                            new Error(
                                "The service worker returned an invalid push cleanup response.",
                            ),
                        );
                    };

                    worker.postMessage(message, [channel.port2]);
                }),
        );
    } catch (error) {
        if (error instanceof Error && /timed out|unavailable/i.test(error.message)) {
            throw new Error(SERVICE_WORKER_UPDATE_REQUIRED_ERROR);
        }

        throw error;
    } finally {
        channel.port1.close();
        channel.port2.close();
    }
}

async function readServiceWorkerPushConfig(
    worker: ServiceWorker,
): Promise<WorkerPushConfig | null> {
    const result = await sendPushConfigMessage(worker, { type: "READ_PUSH_CONFIG" });

    if (!("config" in result)) {
        throw new Error("The service worker did not return its push configuration state.");
    }

    return result.config ?? null;
}

async function configureServiceWorker(
    worker: ServiceWorker,
    credentials: PushCredentials,
    publicKey: string,
): Promise<void> {
    await sendPushConfigMessage(worker, {
        type: "SET_PUSH_CONFIG",
        deliveryKey: credentials.deliveryKey,
        managementKey: credentials.managementKey,
        generation: credentials.generation,
        publicKey,
    });
}

async function clearServiceWorkerPushConfig(
    worker: ServiceWorker,
    cleanup: PendingPushCleanup,
): Promise<void> {
    const result = await sendPushConfigMessage(worker, {
        type: "CLEAR_PUSH_CONFIG",
        generation: cleanup.generation,
        deliveryKey: cleanup.deliveryKey,
    });

    if (result.cleared !== true) {
        throw new Error("The active push configuration did not match this cleanup generation.");
    }
}

async function migrateServiceWorkerPushConfig(
    worker: ServiceWorker,
    managementKey: string,
    generation: string,
): Promise<WorkerPushConfig> {
    const result = await sendPushConfigMessage(worker, {
        type: "MIGRATE_PUSH_CONFIG",
        managementKey,
        generation,
    });

    if (
        !result.config ||
        result.config.managementKey !== managementKey ||
        result.config.generation !== generation ||
        result.config.legacyGeneration !== true
    ) {
        throw new Error("The legacy service-worker push configuration could not be migrated.");
    }

    return result.config;
}

async function generationForManagementKey(managementKey: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(managementKey));

    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
        "",
    );
}

async function readAndMigrateServiceWorkerPushConfig(
    worker: ServiceWorker,
): Promise<WorkerPushConfig | null> {
    const config = await readServiceWorkerPushConfig(worker);

    if (
        !config ||
        (config.generation !== null &&
            !config.legacyGeneration &&
            config.generation !== config.managementKey)
    ) {
        return config;
    }

    const generation = await generationForManagementKey(config.managementKey);

    return migrateServiceWorkerPushConfig(worker, config.managementKey, generation);
}

async function waitForInstallingServiceWorker(
    registration: ServiceWorkerRegistration,
): Promise<ServiceWorker | null> {
    const installing = registration.installing;

    if (!installing) {
        return registration.waiting ?? null;
    }

    if (installing.state === "installed") {
        return registration.waiting ?? null;
    }

    try {
        await bounded(
            "Service-worker update installation",
            () =>
                new Promise<void>((resolve) => {
                    const check = () => {
                        if (installing.state === "installed" || installing.state === "redundant") {
                            installing.removeEventListener("statechange", check);
                            resolve();
                        }
                    };

                    installing.addEventListener("statechange", check);
                    check();
                }),
        );
    } catch {
        return null;
    }

    return (installing.state as string) === "installed" ? (registration.waiting ?? null) : null;
}

async function probeServiceWorker(
    registration: ServiceWorkerRegistration,
): Promise<ServiceWorkerPushSession> {
    let worker = registration.waiting;

    if (!worker) {
        worker = await waitForInstallingServiceWorker(registration);
    }

    // A waiting worker is intentionally preferred. If it is an old protocol, do not silently
    // fall through to the active worker and mutate a different generation.
    worker ??= registration.active ?? null;

    if (!worker) {
        throw new Error(SERVICE_WORKER_UPDATE_REQUIRED_ERROR);
    }

    const config = await readAndMigrateServiceWorkerPushConfig(worker);

    return { registration, worker, config };
}

async function currentSubscription(
    registration: ServiceWorkerRegistration,
    publicKey: string,
    repair: boolean,
): Promise<PushSubscription | null> {
    let subscription = await registration.pushManager.getSubscription();

    if (subscription && pushSubscriptionNeedsRepair(subscription, publicKey)) {
        await subscription.unsubscribe().catch(() => undefined);
        subscription = null;
    }

    if (!subscription && repair) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey(publicKey),
        });
    }

    return subscription;
}

function readPushCredentials(create: boolean): PushCredentials | null {
    const deliveryKey =
        localStorage.getItem(PUSH_DELIVERY_KEY_STORAGE) ??
        localStorage.getItem(LEGACY_PUSH_KEY_STORAGE);
    const managementKey = localStorage.getItem(PUSH_MANAGEMENT_KEY_STORAGE);
    const storedGeneration = localStorage.getItem(PUSH_GENERATION_STORAGE);

    if ((!deliveryKey || !managementKey) && !create) {
        return null;
    }

    return {
        deliveryKey: deliveryKey ?? randomBase64Url(32),
        managementKey: managementKey ?? randomBase64Url(32),
        generation: storedGeneration ?? managementKey ?? randomBase64Url(16),
        ...(managementKey && (storedGeneration === null || storedGeneration === managementKey)
            ? { legacyGeneration: true }
            : {}),
    };
}

function persistPushCredentials(credentials: PushCredentials, endpoint: string): void {
    localStorage.setItem(PUSH_DELIVERY_KEY_STORAGE, credentials.deliveryKey);
    localStorage.setItem(PUSH_MANAGEMENT_KEY_STORAGE, credentials.managementKey);
    localStorage.setItem(PUSH_GENERATION_STORAGE, credentials.generation);
    localStorage.setItem(PUSH_ENDPOINT_STORAGE, endpoint);
    localStorage.removeItem(LEGACY_PUSH_KEY_STORAGE);
}

function clearPushCredentials(
    generation?: string | null,
    managementKey?: string | null,
    deliveryKey?: string | null,
): void {
    const storedGeneration = localStorage.getItem(PUSH_GENERATION_STORAGE);

    if (
        generation &&
        storedGeneration !== generation &&
        !(
            (storedGeneration === null || storedGeneration === managementKey) &&
            managementKey &&
            deliveryKey &&
            localStorage.getItem(PUSH_MANAGEMENT_KEY_STORAGE) === managementKey &&
            localStorage.getItem(PUSH_DELIVERY_KEY_STORAGE) === deliveryKey
        )
    ) {
        return;
    }

    localStorage.removeItem(PUSH_DELIVERY_KEY_STORAGE);
    localStorage.removeItem(PUSH_MANAGEMENT_KEY_STORAGE);
    localStorage.removeItem(PUSH_GENERATION_STORAGE);
    localStorage.removeItem(PUSH_ENDPOINT_STORAGE);
    localStorage.removeItem(LEGACY_PUSH_KEY_STORAGE);
}

function validCleanup(value: unknown): value is PendingPushCleanup {
    if (!value || typeof value !== "object") {
        return false;
    }

    const cleanup = value as Partial<PendingPushCleanup>;

    return (
        cleanup.version === 1 &&
        typeof cleanup.cleanupId === "string" &&
        (cleanup.generation === null || typeof cleanup.generation === "string") &&
        (cleanup.deliveryKey === null || typeof cleanup.deliveryKey === "string") &&
        (cleanup.managementKey === null || typeof cleanup.managementKey === "string") &&
        (cleanup.endpoint === null || typeof cleanup.endpoint === "string") &&
        typeof cleanup.gatewayDone === "boolean" &&
        (cleanup.pusherDone === undefined || typeof cleanup.pusherDone === "boolean") &&
        (cleanup.allowPusherAbandonment === undefined ||
            typeof cleanup.allowPusherAbandonment === "boolean") &&
        typeof cleanup.subscriptionDone === "boolean" &&
        typeof cleanup.workerDone === "boolean" &&
        typeof cleanup.notificationsDone === "boolean" &&
        typeof cleanup.badgeDone === "boolean" &&
        (cleanup.additionalTargets === undefined ||
            (Array.isArray(cleanup.additionalTargets) &&
                cleanup.additionalTargets.every(
                    (target) =>
                        Boolean(target) &&
                        typeof target === "object" &&
                        typeof (target as Partial<PushCleanupTarget>).deliveryKey === "string" &&
                        typeof (target as Partial<PushCleanupTarget>).managementKey === "string" &&
                        typeof (target as Partial<PushCleanupTarget>).gatewayDone === "boolean" &&
                        ((target as Partial<PushCleanupTarget>).pusherDone === undefined ||
                            typeof (target as Partial<PushCleanupTarget>).pusherDone === "boolean"),
                )))
    );
}

function readPendingPushCleanup(): PendingPushCleanup | null {
    const stored = localStorage.getItem(PUSH_CLEANUP_STORAGE);

    if (!stored) {
        return null;
    }

    try {
        const parsed: unknown = JSON.parse(stored);

        if (validCleanup(parsed)) {
            parsed.pusherDone ??= !parsed.deliveryKey;
            parsed.allowPusherAbandonment ??= false;

            for (const target of parsed.additionalTargets ?? []) {
                target.pusherDone ??= false;
            }

            return parsed;
        }
    } catch {
        // Preserve the damaged record rather than losing its management capability.
    }

    throw new Error("The saved notification cleanup record is damaged. Clear this site's data.");
}

function persistPendingPushCleanup(cleanup: PendingPushCleanup): void {
    localStorage.setItem(PUSH_CLEANUP_STORAGE, JSON.stringify(cleanup));
}

function readFallbackPushCleanup(): FallbackPushCleanup | null {
    const stored = localStorage.getItem(PUSH_FALLBACK_CLEANUP_STORAGE);

    if (!stored) {
        return null;
    }

    try {
        const parsed = JSON.parse(stored) as Partial<FallbackPushCleanup>;

        if (
            parsed.version === 1 &&
            Array.isArray(parsed.targets) &&
            parsed.targets.length > 0 &&
            parsed.targets.every(
                (target) =>
                    Boolean(target) &&
                    typeof target.deliveryKey === "string" &&
                    typeof target.managementKey === "string" &&
                    typeof target.generation === "string" &&
                    typeof target.endpoint === "string" &&
                    typeof target.workerMayBeConfigured === "boolean",
            )
        ) {
            return parsed as FallbackPushCleanup;
        }
    } catch {
        // Preserve the damaged record rather than silently dropping its management capability.
    }

    throw new Error("The fallback notification cleanup record is damaged. Clear this site's data.");
}

function persistFallbackPushCleanupTarget(
    credentials: PushCredentials,
    endpoint: string,
    workerMayBeConfigured: boolean,
): boolean {
    try {
        const fallback = readFallbackPushCleanup() ?? { version: 1 as const, targets: [] };
        const existing = fallback.targets.find(
            (target) => target.managementKey === credentials.managementKey,
        );

        if (existing) {
            existing.workerMayBeConfigured ||= workerMayBeConfigured;
        } else {
            fallback.targets.push({
                deliveryKey: credentials.deliveryKey,
                managementKey: credentials.managementKey,
                generation: credentials.generation,
                endpoint,
                workerMayBeConfigured,
            });
        }

        localStorage.setItem(PUSH_FALLBACK_CLEANUP_STORAGE, JSON.stringify(fallback));

        return true;
    } catch {
        return false;
    }
}

function mergeFallbackPushCleanup(
    cleanup: PendingPushCleanup,
    fallback: FallbackPushCleanup,
): void {
    for (const target of fallback.targets) {
        const duplicate =
            cleanup.managementKey === target.managementKey ||
            cleanup.additionalTargets?.some(
                (candidate) => candidate.managementKey === target.managementKey,
            );

        if (!duplicate) {
            cleanup.additionalTargets = [
                ...(cleanup.additionalTargets ?? []),
                {
                    deliveryKey: target.deliveryKey,
                    managementKey: target.managementKey,
                    gatewayDone: false,
                    pusherDone: false,
                },
            ];
        }
    }

    cleanup.subscriptionDone = false;
}

function beginLocalPushCleanup(): PendingPushCleanup {
    localStorage.setItem(PUSH_LIFECYCLE_EPOCH_STORAGE, randomBase64Url(16));
    const pending = readPendingPushCleanup();
    const fallback = readFallbackPushCleanup();

    if (pending) {
        if (fallback) {
            mergeFallbackPushCleanup(pending, fallback);
        }

        clearPushCredentials(pending.generation, pending.managementKey, pending.deliveryKey);

        return pending;
    }

    if (fallback) {
        const [primary, ...additional] = fallback.targets;
        const cleanup: PendingPushCleanup = {
            version: 1,
            cleanupId: randomBase64Url(16),
            generation: primary.generation,
            deliveryKey: primary.deliveryKey,
            managementKey: primary.managementKey,
            endpoint: primary.endpoint,
            gatewayDone: false,
            pusherDone: false,
            allowPusherAbandonment: false,
            subscriptionDone: false,
            workerDone: !primary.workerMayBeConfigured,
            notificationsDone: false,
            badgeDone: false,
            additionalTargets: additional.map((target) => ({
                deliveryKey: target.deliveryKey,
                managementKey: target.managementKey,
                gatewayDone: false,
                pusherDone: false,
            })),
        };

        try {
            persistPendingPushCleanup(cleanup);
        } catch {
            // The compact fallback remains the authoritative retry capability.
        }

        clearPushCredentials(cleanup.generation, cleanup.managementKey, cleanup.deliveryKey);

        return cleanup;
    }

    const credentials = readPushCredentials(false);
    const deliveryKey =
        credentials?.deliveryKey ??
        localStorage.getItem(PUSH_DELIVERY_KEY_STORAGE) ??
        localStorage.getItem(LEGACY_PUSH_KEY_STORAGE);
    const managementKey =
        credentials?.managementKey ?? localStorage.getItem(PUSH_MANAGEMENT_KEY_STORAGE);
    const generation =
        credentials?.generation ?? localStorage.getItem(PUSH_GENERATION_STORAGE) ?? managementKey;
    const cleanup: PendingPushCleanup = {
        version: 1,
        cleanupId: randomBase64Url(16),
        generation,
        deliveryKey,
        managementKey,
        endpoint: localStorage.getItem(PUSH_ENDPOINT_STORAGE),
        gatewayDone: !managementKey,
        pusherDone: !deliveryKey,
        allowPusherAbandonment: false,
        subscriptionDone: false,
        workerDone: false,
        notificationsDone: false,
        badgeDone: false,
    };

    persistPendingPushCleanup(cleanup);
    clearPushCredentials(cleanup.generation, cleanup.managementKey, cleanup.deliveryKey);

    return cleanup;
}

function pushLifecycleEpoch(): string {
    const stored = localStorage.getItem(PUSH_LIFECYCLE_EPOCH_STORAGE);

    if (stored) {
        return stored;
    }

    const created = randomBase64Url(16);

    localStorage.setItem(PUSH_LIFECYCLE_EPOCH_STORAGE, created);

    return created;
}

function queuePushSetupCleanup(
    credentials: PushCredentials,
    endpoint: string,
    workerMayBeConfigured: boolean,
    lifecycleEpoch = randomBase64Url(16),
): PushSetupCleanupQueueResult {
    try {
        const pending = readPendingPushCleanup();

        if (pending) {
            const duplicate =
                pending.managementKey === credentials.managementKey ||
                pending.additionalTargets?.some(
                    (target) => target.managementKey === credentials.managementKey,
                );

            if (!duplicate) {
                pending.additionalTargets = [
                    ...(pending.additionalTargets ?? []),
                    {
                        deliveryKey: credentials.deliveryKey,
                        managementKey: credentials.managementKey,
                        gatewayDone: false,
                        pusherDone: false,
                    },
                ];
            }

            pending.subscriptionDone = false;
            localStorage.setItem(PUSH_LIFECYCLE_EPOCH_STORAGE, lifecycleEpoch);
            persistPendingPushCleanup(pending);

            return "primary";
        }

        const active = readPushCredentials(false);
        const protectsAnotherGeneration = Boolean(
            active &&
            active.generation !== credentials.generation &&
            (active.deliveryKey !== credentials.deliveryKey ||
                active.managementKey !== credentials.managementKey),
        );
        const cleanup: PendingPushCleanup = {
            version: 1,
            cleanupId: randomBase64Url(16),
            generation: credentials.generation,
            deliveryKey: credentials.deliveryKey,
            managementKey: credentials.managementKey,
            endpoint,
            gatewayDone: false,
            pusherDone: false,
            allowPusherAbandonment: false,
            subscriptionDone: protectsAnotherGeneration,
            workerDone: protectsAnotherGeneration,
            notificationsDone: protectsAnotherGeneration,
            badgeDone: protectsAnotherGeneration,
        };

        localStorage.setItem(PUSH_LIFECYCLE_EPOCH_STORAGE, lifecycleEpoch);
        persistPendingPushCleanup(cleanup);

        if (!protectsAnotherGeneration) {
            clearPushCredentials(
                credentials.generation,
                credentials.managementKey,
                credentials.deliveryKey,
            );
        }

        return "primary";
    } catch {
        return persistFallbackPushCleanupTarget(credentials, endpoint, workerMayBeConfigured)
            ? "fallback"
            : "none";
    }
}

async function rollbackUndurablePushSetup(
    service: MatrixService,
    workerSession: ServiceWorkerPushSession,
    subscription: PushSubscription,
    credentials: PushCredentials,
): Promise<void> {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), PUSH_CLEANUP_TIMEOUT_MS);

    await Promise.allSettled([
        gatewayRequest(
            "DELETE",
            { managementKey: credentials.managementKey },
            "/api/push/subscriptions",
            controller.signal,
        ),
        bounded("Matrix pusher rollback", () => service.removePusher(credentials.deliveryKey)),
    ]);
    window.clearTimeout(timeout);

    const active = readPushCredentials(false);

    if (active && active.generation !== credentials.generation) {
        return;
    }

    let safeToUnsubscribe = false;
    const cleanup: PendingPushCleanup = {
        version: 1,
        cleanupId: randomBase64Url(16),
        generation: credentials.generation,
        deliveryKey: credentials.deliveryKey,
        managementKey: credentials.managementKey,
        endpoint: subscription.endpoint,
        gatewayDone: false,
        pusherDone: false,
        allowPusherAbandonment: false,
        subscriptionDone: false,
        workerDone: false,
        notificationsDone: false,
        badgeDone: false,
    };

    try {
        await clearServiceWorkerPushConfig(workerSession.worker, cleanup);
        safeToUnsubscribe = true;
    } catch {
        try {
            safeToUnsubscribe = (await readServiceWorkerPushConfig(workerSession.worker)) === null;
        } catch {
            // An unverifiable worker config may still recreate a subscription.
        }
    }

    if (safeToUnsubscribe) {
        try {
            const current = await bounded("Push subscription rollback lookup", () =>
                workerSession.registration.pushManager.getSubscription(),
            );

            if (current?.endpoint === subscription.endpoint) {
                await bounded("Push subscription rollback", () => current.unsubscribe());
            }
        } catch {
            // Remote capabilities were already revoked above; browser cleanup remains retryable.
        }
    }

    clearPushCredentials(
        credentials.generation,
        credentials.managementKey,
        credentials.deliveryKey,
    );
}

export function hasPendingLocalPushCleanup(): boolean {
    return (
        localStorage.getItem(PUSH_CLEANUP_STORAGE) !== null ||
        localStorage.getItem(PUSH_FALLBACK_CLEANUP_STORAGE) !== null ||
        localStorage.getItem(PUSH_CLEANUP_INTENT_STORAGE) !== null
    );
}

function hasDurablePushCleanupRecord(): boolean {
    try {
        return (
            localStorage.getItem(PUSH_CLEANUP_STORAGE) !== null ||
            localStorage.getItem(PUSH_FALLBACK_CLEANUP_STORAGE) !== null
        );
    } catch {
        return false;
    }
}

export function hasLocalPushStateForCleanup(): boolean {
    return (
        hasPendingLocalPushCleanup() ||
        localStorage.getItem(PUSH_CLEANUP_INTENT_STORAGE) !== null ||
        localStorage.getItem(PUSH_DELIVERY_KEY_STORAGE) !== null ||
        localStorage.getItem(PUSH_MANAGEMENT_KEY_STORAGE) !== null ||
        localStorage.getItem(PUSH_GENERATION_STORAGE) !== null ||
        localStorage.getItem(PUSH_ENDPOINT_STORAGE) !== null ||
        localStorage.getItem(PUSH_LIFECYCLE_EPOCH_STORAGE) !== null ||
        localStorage.getItem(LEGACY_PUSH_KEY_STORAGE) !== null
    );
}

function pushDatabaseFactory(): IDBFactory {
    if (!("indexedDB" in window) || !window.indexedDB) {
        throw new Error("IndexedDB is unavailable, so notification cleanup cannot be verified.");
    }

    return window.indexedDB;
}

async function pushDatabaseExists(): Promise<boolean> {
    const factory = pushDatabaseFactory();

    if (typeof factory.databases !== "function") {
        throw new Error(
            "IndexedDB database enumeration is unavailable, so notification cleanup cannot be verified.",
        );
    }

    const databases = await bounded("Push database artifact lookup", () => factory.databases());

    return databases.some((database) => database.name === PUSH_DATABASE);
}

function strictPersistedPushConfig(value: unknown): PushCredentials | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }

    const config = value as Record<string, unknown>;
    const keys = Object.keys(config).sort();
    const currentKeys = [
        "deliveryKey",
        "generation",
        "legacyGeneration",
        "managementKey",
        "publicKey",
    ];
    const currentKeysWithoutMarker = ["deliveryKey", "generation", "managementKey", "publicKey"];
    const legacyKeys = ["deliveryKey", "managementKey", "publicKey"];
    const validShape =
        (keys.length === currentKeys.length &&
            keys.every((key, index) => key === currentKeys[index])) ||
        (keys.length === currentKeysWithoutMarker.length &&
            keys.every((key, index) => key === currentKeysWithoutMarker[index])) ||
        (keys.length === legacyKeys.length &&
            keys.every((key, index) => key === legacyKeys[index]));
    const validToken = (token: unknown) =>
        typeof token === "string" && token.length > 0 && token.length <= 512;
    const validCapability = (token: unknown) =>
        typeof token === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(token);
    const validGeneration = (generation: unknown) =>
        typeof generation === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(generation);

    if (
        !validShape ||
        !validCapability(config.deliveryKey) ||
        !validCapability(config.managementKey) ||
        config.deliveryKey === config.managementKey ||
        !validToken(config.publicKey) ||
        ("generation" in config && !validGeneration(config.generation)) ||
        ("legacyGeneration" in config && typeof config.legacyGeneration !== "boolean")
    ) {
        return null;
    }

    return {
        deliveryKey: config.deliveryKey as string,
        managementKey: config.managementKey as string,
        // Pre-generation workers fenced cleanup by delivery key. Using the management capability
        // as their stable generation matches the legacy local-credential migration behavior.
        generation: (config.generation as string | undefined) ?? (config.managementKey as string),
    };
}

async function openExistingPushDatabase(factory: IDBFactory): Promise<IDBDatabase> {
    return bounded(
        "Orphaned push database open",
        () =>
            new Promise<IDBDatabase>((resolve, reject) => {
                const request = factory.open(PUSH_DATABASE);
                let createdDuringOpen = false;

                request.onupgradeneeded = () => {
                    createdDuringOpen = true;
                    request.transaction?.abort();
                };

                request.onsuccess = () => {
                    if (createdDuringOpen) {
                        request.result.close();
                        reject(
                            new Error(
                                "The orphaned push database changed while cleanup was inspecting it.",
                            ),
                        );

                        return;
                    }

                    resolve(request.result);
                };

                request.onerror = () =>
                    reject(
                        createdDuringOpen
                            ? new Error(
                                  "The orphaned push database changed while cleanup was inspecting it.",
                              )
                            : (request.error ??
                                  new Error("The orphaned push database could not be opened.")),
                    );
                request.onblocked = () =>
                    reject(new Error("The orphaned push database is open elsewhere."));
            }),
    );
}

async function inspectOrphanedPushDatabase(): Promise<OrphanedPushDatabaseState> {
    if (!(await pushDatabaseExists())) {
        return { exists: false };
    }

    const database = await openExistingPushDatabase(pushDatabaseFactory());

    try {
        if (
            database.version !== PUSH_DATABASE_VERSION ||
            database.objectStoreNames.length !== 1 ||
            !database.objectStoreNames.contains(PUSH_SETTINGS_STORE)
        ) {
            throw new Error("The orphaned push database has an unrecognized schema.");
        }

        const value = await bounded(
            "Orphaned push configuration lookup",
            () =>
                new Promise<unknown>((resolve, reject) => {
                    const transaction = database.transaction(PUSH_SETTINGS_STORE, "readonly");
                    const request = transaction
                        .objectStore(PUSH_SETTINGS_STORE)
                        .get(PUSH_CONFIG_KEY);
                    let result: unknown;

                    request.onsuccess = () => {
                        result = request.result;
                    };

                    request.onerror = () =>
                        reject(
                            request.error ??
                                new Error("The orphaned push configuration could not be read."),
                        );
                    transaction.oncomplete = () => resolve(result);
                    transaction.onabort = () =>
                        reject(
                            transaction.error ??
                                new Error("The orphaned push configuration read was aborted."),
                        );
                    transaction.onerror = () =>
                        reject(
                            transaction.error ??
                                new Error("The orphaned push configuration could not be read."),
                        );
                }),
        );
        const credentials = strictPersistedPushConfig(value);

        if (!credentials) {
            throw new Error("The orphaned push configuration is missing or malformed.");
        }

        if (credentials.generation === credentials.managementKey) {
            credentials.generation = await generationForManagementKey(credentials.managementKey);
            credentials.legacyGeneration = true;
        }

        return { exists: true, credentials };
    } finally {
        database.close();
    }
}

function mergeOrphanedPushCredentials(
    cleanup: PendingPushCleanup,
    credentials: PushCredentials,
): void {
    // Do not expose recovered capabilities to the remote cleanup steps until the journal has
    // accepted them. This makes the journal write the recovery linearization point even if
    // localStorage becomes unavailable midway through cleanup.
    const recovered: PendingPushCleanup = {
        ...cleanup,
        additionalTargets: cleanup.additionalTargets?.map((target) => ({ ...target })),
    };

    if (!recovered.deliveryKey && !recovered.managementKey) {
        recovered.deliveryKey = credentials.deliveryKey;
        recovered.managementKey = credentials.managementKey;
        recovered.generation = credentials.generation;
        recovered.gatewayDone = false;
        recovered.pusherDone = false;
    } else if (recovered.managementKey === credentials.managementKey) {
        if (
            (recovered.deliveryKey && recovered.deliveryKey !== credentials.deliveryKey) ||
            (recovered.generation && recovered.generation !== credentials.generation)
        ) {
            throw new Error("The orphaned push configuration conflicts with its cleanup journal.");
        }

        if (!recovered.deliveryKey) {
            recovered.deliveryKey = credentials.deliveryKey;
            recovered.pusherDone = false;
        }

        recovered.generation ??= credentials.generation;
    } else {
        const existing = recovered.additionalTargets?.find(
            (target) => target.managementKey === credentials.managementKey,
        );

        if (existing && existing.deliveryKey !== credentials.deliveryKey) {
            throw new Error("The orphaned push configuration conflicts with its cleanup journal.");
        }

        if (!existing) {
            recovered.additionalTargets = [
                ...(recovered.additionalTargets ?? []),
                {
                    deliveryKey: credentials.deliveryKey,
                    managementKey: credentials.managementKey,
                    gatewayDone: false,
                    pusherDone: false,
                },
            ];
        }
    }

    recovered.subscriptionDone = false;
    recovered.workerDone = false;
    recovered.notificationsDone = false;
    // This is the critical linearization point: after it succeeds, the cleanup journal is the
    // durable owner of every remote revocation capability formerly held only by IndexedDB.
    persistPendingPushCleanup(recovered);
    Object.assign(cleanup, recovered);
}

export async function hasBrowserPushArtifacts(): Promise<boolean> {
    if (hasLocalPushStateForCleanup()) {
        return true;
    }

    try {
        const registration =
            "serviceWorker" in navigator
                ? await bounded("Service-worker artifact lookup", () =>
                      navigator.serviceWorker.getRegistration(),
                  )
                : undefined;

        if (!registration) {
            return pushDatabaseExists();
        }

        const subscription = await bounded("Push subscription artifact lookup", () =>
            registration.pushManager.getSubscription(),
        );
        const notifications = await bounded("Displayed notification artifact lookup", () =>
            registration.getNotifications(),
        );

        // A registration may be visible before its first worker reaches active. The browser
        // surfaces remain inspectable in that state; messaging registration.active would turn a
        // clean first load into a durable cleanup gate.
        if (!registration.active) {
            return Boolean(subscription || notifications.length || (await pushDatabaseExists()));
        }

        const session = await probeServiceWorker(registration);

        return Boolean(subscription || notifications.length || session.config);
    } catch {
        // Fail closed: an uninspectable browser push surface must be cleaned before a new login.
        return true;
    }
}

async function deleteOrphanedPushDatabase(): Promise<void> {
    const factory = pushDatabaseFactory();

    await bounded(
        "Orphaned push database cleanup",
        () =>
            new Promise<void>((resolve, reject) => {
                const request = factory.deleteDatabase(PUSH_DATABASE);

                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
                request.onblocked = () => reject(new Error("The push database is open elsewhere."));
            }),
    );
}

async function registerGatewaySubscription(
    credentials: PushCredentials,
    subscription: PushSubscription,
): Promise<void> {
    let confirmationReceived = false;
    let resolveConfirmation: () => void = () => undefined;
    const confirmation = new Promise<void>((resolve) => {
        resolveConfirmation = resolve;
    });

    const onMessage = (event: MessageEvent) => {
        if (event.data?.type !== "PUSH_SUBSCRIPTION_CONFIRMED") {
            return;
        }

        confirmationReceived = true;
        resolveConfirmation();
    };

    navigator.serviceWorker.addEventListener("message", onMessage);

    try {
        const body = {
            deliveryKey: credentials.deliveryKey,
            managementKey: credentials.managementKey,
            generation: credentials.generation,
            subscription: subscription.toJSON(),
        };
        const result = await gatewayRequest("POST", body);

        if (result.registered === true) {
            return;
        }

        if (result.pending !== true) {
            throw new Error("The push gateway returned an invalid registration state.");
        }

        if (!confirmationReceived) {
            await Promise.race([
                confirmation,
                new Promise<void>((_resolve, reject) => {
                    window.setTimeout(
                        () =>
                            reject(
                                new Error("The browser did not confirm the push endpoint in time."),
                            ),
                        PUSH_CONFIRMATION_TIMEOUT_MS,
                    );
                }),
            ]);
        }

        const confirmed = await gatewayRequest("POST", body);

        if (confirmed.registered !== true) {
            throw new Error("The browser push endpoint was not confirmed.");
        }
    } finally {
        navigator.serviceWorker.removeEventListener("message", onMessage);
    }
}

export function isLegacySitesPusher(pusher: { app_id?: string; data?: { url?: string } }): boolean {
    if (pusher.app_id !== PUSH_APP_ID || typeof pusher.data?.url !== "string") {
        return false;
    }

    try {
        return new URL(pusher.data.url).hostname.endsWith(LEGACY_PUSH_HOST_SUFFIX);
    } catch {
        return false;
    }
}

async function removeLegacySitesPushers(service: MatrixService): Promise<void> {
    const { pushers } = await service.getClient().getPushers();

    await Promise.allSettled(
        pushers.filter(isLegacySitesPusher).map((pusher) => service.removePusher(pusher.pushkey)),
    );
}

function currentPusherUrl(): string {
    return `${window.location.origin}/_matrix/push/v1/notify`;
}

async function registerMatrixPusher(service: MatrixService, pushKey: string): Promise<void> {
    await service.getClient().setPusher({
        app_display_name: "Sub-Etha",
        app_id: PUSH_APP_ID,
        append: false,
        data: {
            format: "event_id_only",
            url: currentPusherUrl(),
        },
        device_display_name: "Sub-Etha PWA",
        kind: "http",
        lang: navigator.language || "en",
        pushkey: pushKey,
    });
}

async function reconcileMatrixPusher(service: MatrixService, pushKey: string): Promise<void> {
    const expectedUrl = currentPusherUrl();
    const { pushers } = await service.getClient().getPushers();
    const current = pushers.some(
        (pusher) =>
            pusher.app_id === PUSH_APP_ID &&
            pusher.pushkey === pushKey &&
            pusher.kind === "http" &&
            pusher.data?.format === "event_id_only" &&
            pusher.data?.url === expectedUrl,
    );

    if (!current) {
        await registerMatrixPusher(service, pushKey);
    }
}

function assertOwnedPushSetupJournal(credentials: PushCredentials, lifecycleEpoch: string): void {
    const pending = readPendingPushCleanup();

    if (
        localStorage.getItem(PUSH_LIFECYCLE_EPOCH_STORAGE) !== lifecycleEpoch ||
        localStorage.getItem(PUSH_CLEANUP_INTENT_STORAGE) !== null ||
        pending?.managementKey !== credentials.managementKey ||
        pending.deliveryKey !== credentials.deliveryKey ||
        pending.generation !== credentials.generation ||
        (pending.additionalTargets?.length ?? 0) > 0
    ) {
        throw new Error("Notification cleanup started while push setup was in progress.");
    }
}

async function runDurablePushSetup(
    service: MatrixService,
    registration: ServiceWorkerRegistration,
    publicKey: string,
    initialLifecycleEpoch: string,
    credentialsForSetup: () => PushCredentials | null,
    registerPusher: (credentials: PushCredentials) => Promise<void>,
): Promise<void> {
    await withPushLifecycleLock(async () => {
        if (
            hasPendingLocalPushCleanup() ||
            localStorage.getItem(PUSH_CLEANUP_INTENT_STORAGE) !== null ||
            pushLifecycleEpoch() !== initialLifecycleEpoch
        ) {
            throw new Error("Notification cleanup started while push setup was in progress.");
        }

        const workerSession = await probeServiceWorker(registration);
        const subscription = await currentSubscription(registration, publicKey, true);

        if (!subscription) {
            throw new Error("The browser push subscription is unavailable.");
        }

        if (pushLifecycleEpoch() !== initialLifecycleEpoch) {
            throw new Error("Notification cleanup started while push setup was in progress.");
        }

        const credentials = credentialsForSetup();

        if (!credentials) {
            throw new Error("Push credentials could not be created.");
        }

        const workerConfig = workerSession.config;
        const effectiveCredentials = credentials.legacyGeneration
            ? {
                  ...credentials,
                  generation: await generationForManagementKey(credentials.managementKey),
              }
            : workerConfig &&
                workerConfig.deliveryKey === credentials.deliveryKey &&
                workerConfig.managementKey === credentials.managementKey &&
                typeof workerConfig.generation === "string"
              ? { ...credentials, generation: workerConfig.generation }
              : credentials;

        const setupEpoch = randomBase64Url(16);
        const queued = queuePushSetupCleanup(
            effectiveCredentials,
            subscription.endpoint,
            true,
            setupEpoch,
        );

        if (queued !== "primary") {
            await rollbackUndurablePushSetup(
                service,
                workerSession,
                subscription,
                effectiveCredentials,
            );

            throw new Error(
                queued === "fallback"
                    ? "Notification setup was interrupted and cleanup has been safely queued."
                    : "Notification cleanup could not preserve its retry capability. Clear this site's data and revoke this device from another trusted Matrix client.",
            );
        }

        assertOwnedPushSetupJournal(effectiveCredentials, setupEpoch);
        // The gateway challenge is handled by the worker, so the exact generation must be
        // installed before registration begins. The durable journal above makes this safe.
        await configureServiceWorker(workerSession.worker, effectiveCredentials, publicKey);
        assertOwnedPushSetupJournal(effectiveCredentials, setupEpoch);

        await registerGatewaySubscription(effectiveCredentials, subscription);
        assertOwnedPushSetupJournal(effectiveCredentials, setupEpoch);

        await registerPusher(effectiveCredentials);
        assertOwnedPushSetupJournal(effectiveCredentials, setupEpoch);

        const current = await bounded("Push subscription commit check", () =>
            registration.pushManager.getSubscription(),
        );

        assertOwnedPushSetupJournal(effectiveCredentials, setupEpoch);

        if (!current || current.endpoint !== subscription.endpoint) {
            throw new Error("The browser push subscription changed during setup.");
        }

        // Keep the single-record cleanup journal until every sequential credential write and
        // the successful-commit epoch rotation have completed. A crash or quota error at any
        // earlier point therefore retains both remote management capabilities for retry.
        persistPushCredentials(effectiveCredentials, subscription.endpoint);
        localStorage.setItem(PUSH_LIFECYCLE_EPOCH_STORAGE, randomBase64Url(16));
        localStorage.removeItem(PUSH_CLEANUP_STORAGE);
    });
}

export async function refreshPushState(service: MatrixService): Promise<PushState> {
    const initial = readPushState();

    if (!initial.supported) {
        return { ...initial, checking: false };
    }

    if (hasPendingLocalPushCleanup()) {
        const cleanup = await forgetLocalPushState();

        return {
            supported: true,
            enabled: false,
            permission: Notification.permission,
            checking: false,
            ...(cleanup.complete
                ? {}
                : { error: cleanup.error ?? "Notification cleanup must finish before enabling." }),
        };
    }

    const credentials = readPushCredentials(false);

    if (!credentials || Notification.permission !== "granted") {
        const cleanup = await forgetLocalPushState(service);

        return {
            supported: true,
            enabled: false,
            permission: Notification.permission,
            checking: false,
            ...(cleanup.complete ? {} : { error: cleanup.error }),
        };
    }

    const lifecycleEpoch = pushLifecycleEpoch();

    try {
        const registration = await registerServiceWorker();

        if (!registration) {
            return {
                ...initial,
                checking: false,
                error: "The service worker could not be registered.",
            };
        }

        const publicKey = await publicVapidKey();

        await runDurablePushSetup(
            service,
            registration,
            publicKey,
            lifecycleEpoch,
            () => credentials,
            (currentCredentials) => reconcileMatrixPusher(service, currentCredentials.deliveryKey),
        );
        await removeLegacySitesPushers(service).catch(() => undefined);

        return { supported: true, enabled: true, permission: "granted", checking: false };
    } catch (error) {
        if (hasPendingLocalPushCleanup()) {
            await forgetLocalPushState(service);
        }

        return {
            supported: true,
            enabled: false,
            permission: Notification.permission,
            checking: false,
            error:
                error instanceof Error
                    ? error.message
                    : "Closed-app notifications could not be verified.",
        };
    }
}

export async function enablePush(service: MatrixService): Promise<PushState> {
    const initial = readPushState();

    if (!initial.supported) {
        return { ...initial, checking: false, error: "This browser does not support Web Push." };
    }

    if (hasPendingLocalPushCleanup()) {
        const cleanup = await forgetLocalPushState();

        if (!cleanup.complete) {
            return {
                ...initial,
                checking: false,
                error: cleanup.error ?? "Notification cleanup must finish before enabling.",
            };
        }
    }

    const lifecycleEpoch = pushLifecycleEpoch();

    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
        return {
            ...initial,
            permission,
            checking: false,
            error: "Notification permission was not granted.",
        };
    }

    const registration = await registerServiceWorker();

    if (!registration) {
        return {
            ...initial,
            checking: false,
            error: "The service worker could not be registered.",
        };
    }

    const publicKey = await publicVapidKey();

    try {
        await runDurablePushSetup(
            service,
            registration,
            publicKey,
            lifecycleEpoch,
            () => readPushCredentials(true),
            (credentials) => registerMatrixPusher(service, credentials.deliveryKey),
        );
    } catch (error) {
        if (hasPendingLocalPushCleanup()) {
            await forgetLocalPushState(service);
        }

        throw error;
    }

    await removeLegacySitesPushers(service).catch(() => undefined);

    return { supported: true, enabled: true, permission: "granted", checking: false };
}

export async function disablePush(service: MatrixService): Promise<PushState> {
    const cleanup = await forgetLocalPushState(service);

    return {
        supported: true,
        enabled: false,
        permission: Notification.permission,
        checking: false,
        ...(cleanup.complete ? {} : { error: cleanup.error }),
    };
}

async function performLocalPushCleanup(
    service?: MatrixService,
    options?: PushCleanupOptions,
): Promise<PushCleanupResult> {
    const errors: string[] = [];
    let registration: ServiceWorkerRegistration | undefined;
    let workerSession: ServiceWorkerPushSession | undefined;
    let registrationStateKnown = !("serviceWorker" in navigator);
    let orphanedDatabaseReadyForDeletion = false;

    if ("serviceWorker" in navigator) {
        try {
            registration = await bounded("Service-worker registration lookup", () =>
                navigator.serviceWorker.getRegistration(),
            );
            registrationStateKnown = true;
        } catch (error) {
            errors.push(error instanceof Error ? error.message : "Service-worker lookup failed.");
        }
    }

    if (registration) {
        try {
            // Do not create a cleanup journal, revoke remote capabilities, or touch the browser
            // subscription until a protocol-v2 worker has explicitly acknowledged the probe.
            workerSession = await probeServiceWorker(registration);
        } catch (error) {
            return {
                complete: false,
                durable: false,
                ...abandonedMatrixPusherResult(),
                error:
                    error instanceof Error ? error.message : SERVICE_WORKER_UPDATE_REQUIRED_ERROR,
            };
        }
    }

    let cleanup: PendingPushCleanup;

    try {
        cleanup = beginLocalPushCleanup();

        if (options?.abandonMatrixPusherAfterGatewayCleanup && !cleanup.allowPusherAbandonment) {
            cleanup.allowPusherAbandonment = true;
            persistPendingPushCleanup(cleanup);
        }
    } catch (error) {
        return {
            complete: false,
            durable: false,
            ...abandonedMatrixPusherResult(),
            error: error instanceof Error ? error.message : "Notification cleanup could not start.",
        };
    }

    if (cleanup.generation && cleanup.generation === cleanup.managementKey) {
        try {
            cleanup.generation = await generationForManagementKey(cleanup.managementKey!);
            persistPendingPushCleanup(cleanup);
        } catch (error) {
            return {
                complete: false,
                durable: true,
                ...abandonedMatrixPusherResult(),
                error:
                    error instanceof Error
                        ? error.message
                        : "Notification cleanup generation could not be canonicalized.",
            };
        }
    }

    if (
        workerSession?.config &&
        (!cleanup.generation || !cleanup.deliveryKey || !cleanup.managementKey)
    ) {
        cleanup.generation = workerSession.config.generation;
        cleanup.deliveryKey = workerSession.config.deliveryKey;
        cleanup.managementKey = workerSession.config.managementKey;
        cleanup.gatewayDone = false;
        persistPendingPushCleanup(cleanup);
    } else if (
        workerSession?.config &&
        cleanup.deliveryKey === workerSession.config.deliveryKey &&
        cleanup.managementKey === workerSession.config.managementKey &&
        cleanup.generation !== workerSession.config.generation
    ) {
        // Legacy workers are migrated before this point, so their canonical generation becomes
        // the cleanup fence even when an older local journal still used managementKey.
        cleanup.generation = workerSession.config.generation;
        persistPendingPushCleanup(cleanup);
    }

    if (cleanup.generation) {
        clearPushCredentials(cleanup.generation, cleanup.managementKey, cleanup.deliveryKey);
    }

    if (!registration && registrationStateKnown) {
        try {
            const orphanedDatabase = await inspectOrphanedPushDatabase();

            if (orphanedDatabase.exists) {
                mergeOrphanedPushCredentials(cleanup, orphanedDatabase.credentials);
                orphanedDatabaseReadyForDeletion = true;
            } else {
                cleanup.subscriptionDone = true;
                cleanup.workerDone = true;
                cleanup.notificationsDone = true;
            }
        } catch (error) {
            errors.push(
                error instanceof Error ? error.message : "Orphaned push inspection failed.",
            );
        }
    }

    const pusherCleanup = async () => {
        const removals: Promise<void>[] = [];

        const remove = async (deliveryKey: string, markDone: () => void): Promise<void> => {
            if (!service) {
                errors.push(
                    "Unlock this account to finish removing its Matrix notification pusher.",
                );

                return;
            }

            try {
                await bounded("Matrix pusher removal", () => service.removePusher(deliveryKey));
                markDone();
            } catch (error) {
                errors.push(
                    error instanceof Error ? error.message : "Matrix pusher removal failed.",
                );
            }
        };

        if (!cleanup.deliveryKey) {
            cleanup.pusherDone = true;
        } else if (!cleanup.pusherDone) {
            removals.push(
                remove(cleanup.deliveryKey, () => {
                    cleanup.pusherDone = true;
                }),
            );
        }

        for (const target of cleanup.additionalTargets ?? []) {
            if (!target.pusherDone) {
                removals.push(
                    remove(target.deliveryKey, () => {
                        target.pusherDone = true;
                    }),
                );
            }
        }

        await Promise.all(removals);
    };

    const subscriptionCleanup = async () => {
        if (cleanup.subscriptionDone || !registration) {
            return;
        }

        try {
            const subscription = await bounded("Push subscription lookup", () =>
                registration.pushManager.getSubscription(),
            );

            if (!subscription) {
                cleanup.subscriptionDone = true;

                return;
            }

            if (!cleanup.endpoint) {
                cleanup.endpoint = subscription.endpoint;
                persistPendingPushCleanup(cleanup);
            }

            const removed = await bounded("Push subscription removal", () =>
                subscription.unsubscribe(),
            );

            if (!removed) {
                throw new Error("The browser did not confirm push subscription removal.");
            }

            cleanup.subscriptionDone = true;
        } catch (error) {
            errors.push(
                error instanceof Error ? error.message : "Push subscription removal failed.",
            );
        }
    };

    const workerCleanup = async () => {
        if (cleanup.workerDone || !registration) {
            return;
        }

        try {
            if (!workerSession) {
                throw new Error(SERVICE_WORKER_UPDATE_REQUIRED_ERROR);
            }

            await clearServiceWorkerPushConfig(workerSession.worker, cleanup);
            cleanup.workerDone = true;
        } catch (error) {
            errors.push(
                error instanceof Error ? error.message : "Service-worker push cleanup failed.",
            );
        }
    };

    const notificationCleanup = async () => {
        if (cleanup.notificationsDone || !registration) {
            return;
        }

        try {
            const notifications = await bounded("Displayed notification lookup", () =>
                registration.getNotifications(),
            );

            for (const notification of notifications) {
                try {
                    notification.close();
                } catch {
                    throw new Error("A displayed notification could not be closed.");
                }
            }

            cleanup.notificationsDone = true;
        } catch (error) {
            errors.push(
                error instanceof Error ? error.message : "Displayed notification cleanup failed.",
            );
        }
    };

    const badgeCleanup = async () => {
        if (cleanup.badgeDone) {
            return;
        }

        try {
            if ("clearAppBadge" in navigator) {
                await bounded("App badge cleanup", () => navigator.clearAppBadge());
            }

            cleanup.badgeDone = true;
        } catch (error) {
            errors.push(error instanceof Error ? error.message : "App badge cleanup failed.");
        }
    };

    const gatewayCleanup = async () => {
        const remove = async (managementKey: string, markDone: () => void): Promise<void> => {
            const controller = new AbortController();
            const timeout = window.setTimeout(() => controller.abort(), PUSH_CLEANUP_TIMEOUT_MS);

            try {
                await gatewayRequest(
                    "DELETE",
                    { managementKey },
                    "/api/push/subscriptions",
                    controller.signal,
                );
                markDone();
            } catch (error) {
                if (error instanceof Error && /not found/i.test(error.message)) {
                    markDone();
                } else {
                    errors.push(
                        error instanceof Error ? error.message : "Push gateway cleanup failed.",
                    );
                }
            } finally {
                window.clearTimeout(timeout);
            }
        };

        const removals: Promise<void>[] = [];

        if (!cleanup.managementKey) {
            cleanup.gatewayDone = true;
        } else if (!cleanup.gatewayDone) {
            removals.push(
                remove(cleanup.managementKey, () => {
                    cleanup.gatewayDone = true;
                }),
            );
        }

        for (const target of cleanup.additionalTargets ?? []) {
            if (!target.gatewayDone) {
                removals.push(
                    remove(target.managementKey, () => {
                        target.gatewayDone = true;
                    }),
                );
            }
        }

        await Promise.all(removals);
    };

    await Promise.all([
        workerCleanup(),
        notificationCleanup(),
        badgeCleanup(),
        gatewayCleanup(),
        pusherCleanup(),
    ]);

    if (
        cleanup.allowPusherAbandonment &&
        cleanup.gatewayDone &&
        (cleanup.additionalTargets?.every((target) => target.gatewayDone) ?? true)
    ) {
        const unfinishedPusher =
            !cleanup.pusherDone ||
            (cleanup.additionalTargets?.some((target) => !target.pusherDone) ?? false);

        if (unfinishedPusher) {
            if (persistAbandonedMatrixPusherWarning()) {
                cleanup.pusherDone = true;

                for (const target of cleanup.additionalTargets ?? []) {
                    target.pusherDone = true;
                }
            } else {
                errors.push(
                    "The Matrix pusher warning could not be saved; cleanup will retry before removing its journal.",
                );
            }
        }
    }

    if (
        orphanedDatabaseReadyForDeletion &&
        cleanup.gatewayDone &&
        cleanup.pusherDone &&
        (cleanup.additionalTargets?.every((target) => target.gatewayDone && target.pusherDone) ??
            true)
    ) {
        try {
            await deleteOrphanedPushDatabase();
            cleanup.subscriptionDone = true;
            cleanup.workerDone = true;
            cleanup.notificationsDone = true;
        } catch (error) {
            errors.push(error instanceof Error ? error.message : "Orphaned push cleanup failed.");
        }
    }

    if (cleanup.workerDone) {
        await subscriptionCleanup();
    } else if (!cleanup.subscriptionDone) {
        errors.push("Push subscription removal is waiting for durable service-worker cleanup.");
    }

    const complete =
        cleanup.gatewayDone &&
        cleanup.pusherDone &&
        cleanup.subscriptionDone &&
        cleanup.workerDone &&
        cleanup.notificationsDone &&
        cleanup.badgeDone &&
        (cleanup.additionalTargets?.every((target) => target.gatewayDone && target.pusherDone) ??
            true);

    try {
        if (complete) {
            localStorage.removeItem(PUSH_CLEANUP_STORAGE);
            localStorage.removeItem(PUSH_FALLBACK_CLEANUP_STORAGE);
            localStorage.removeItem(PUSH_CLEANUP_INTENT_STORAGE);
            localStorage.removeItem(PUSH_LIFECYCLE_EPOCH_STORAGE);
        } else {
            persistPendingPushCleanup(cleanup);
        }
    } catch (error) {
        return {
            complete: false,
            durable: hasPendingLocalPushCleanup(),
            ...abandonedMatrixPusherResult(),
            error:
                error instanceof Error ? error.message : "Notification cleanup could not be saved.",
        };
    }

    return {
        complete,
        durable: true,
        ...abandonedMatrixPusherResult(),
        ...(complete
            ? {}
            : {
                  error:
                      errors.join(" ") ||
                      "Notification cleanup is safely queued and needs another retry.",
              }),
    };
}

export async function forgetLocalPushState(
    service?: MatrixService,
    options?: PushCleanupOptions,
): Promise<PushCleanupResult> {
    let durableIntent = false;

    try {
        // This write deliberately happens before waiting for the lifecycle lock. It both gates a
        // reload and invalidates any setup currently paused inside an asynchronous browser or
        // network operation; that setup must observe the changed epoch before it can commit.
        localStorage.setItem(PUSH_CLEANUP_INTENT_STORAGE, randomBase64Url(16));
        localStorage.setItem(PUSH_LIFECYCLE_EPOCH_STORAGE, randomBase64Url(16));
        durableIntent = true;
    } catch {
        // We still attempt an immediate locked cleanup, but cannot claim crash-safe intent unless
        // an existing cleanup record already carries the remote management capability.
    }

    try {
        const result = await withPushLifecycleLock(() => performLocalPushCleanup(service, options));

        return {
            ...result,
            durable: result.durable || durableIntent || hasDurablePushCleanupRecord(),
        };
    } catch (error) {
        return {
            complete: false,
            durable: hasDurablePushCleanupRecord() || durableIntent,
            ...abandonedMatrixPusherResult(),
            error: error instanceof Error ? error.message : "Notification cleanup could not start.",
        };
    }
}

export async function sendTestPush(): Promise<void> {
    const credentials = readPushCredentials(false);

    if (!credentials) {
        throw new Error("Enable closed-app notifications before sending a test.");
    }

    await gatewayRequest("POST", { managementKey: credentials.managementKey }, "/api/push/test");
}
