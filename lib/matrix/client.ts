import {
    ClientEvent,
    EventTimeline,
    EventType,
    MemoryStore,
    MatrixClient,
    MatrixEvent,
    MatrixEventEvent,
    MatrixScheduler,
    NotificationCountType,
    OAuth2,
    RelationType,
    RoomEvent,
    RoomMemberEvent,
    SyncState,
    createClient,
    type IPusherRequest,
    type Room,
} from "matrix-js-sdk";
import { CryptoEvent, type GeneratedSecretStorageKey } from "matrix-js-sdk/lib/crypto-api";
import {
    VerificationPhase,
    VerificationRequestEvent,
    VerifierEvent,
    type ShowSasCallbacks,
    type VerificationRequest,
    type Verifier,
} from "matrix-js-sdk/lib/crypto-api/verification";
import { decodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import { deriveRecoveryKeyFromPassphrase } from "matrix-js-sdk/lib/crypto-api/key-passphrase";
import {
    decryptAttachment,
    encryptAttachment,
    type IEncryptedFile,
} from "matrix-encrypt-attachment";
import {
    base64UrlToBytes,
    cleanupExactSessionDatabasesWhileHoldingVaultLock,
    cleanupSessionDatabases,
    completeLocalSessionCleanup,
    deleteSessionRecord,
    SESSION_VAULT_LOCK_NAME,
    type SessionCleanupDescriptor,
    type SessionDeletionResult,
    type SessionLease,
} from "./session-store";
import { humanizeMatrixError } from "./auth";
import { assertAllowedHomeserverUrl } from "./url-policy";
import {
    assertMediaByteLength,
    assertDeclaredMediaLimits,
    assertSafeImageBytes,
    boundedMediaString,
    canonicalMediaFileName,
    encryptedMediaDigest,
    imageDimensions,
    isImageUploadCandidate,
    isSafeNonNegativeInteger,
    MediaBusyError,
    MediaOperationGate,
    MAX_AVATAR_BYTES,
    MAX_ENCRYPTED_UPLOAD_BYTES,
    MAX_IMAGE_BYTES,
    MAX_IMAGE_DECODED_BYTES,
    MAX_MEDIA_CONFIG_BYTES,
    MAX_MEDIA_CACHE_BYTES,
    MAX_MEDIA_CACHE_ENTRIES,
    MAX_NONIMAGE_MEDIA_BYTES,
    MAX_PLAIN_UPLOAD_BYTES,
    MEDIA_IDLE_TIMEOUT_MS,
    MEDIA_IMAGE_DEADLINE_MS,
    MEDIA_NONIMAGE_DEADLINE_MS,
    MediaLimitError,
    MediaTimeoutError,
    normalizeMediaFile,
    readBoundedResponse,
    type MediaExpectedKind,
    type MediaOperationLease,
} from "./media";
import { normalizeRooms, normalizeTimeline } from "./normalize";
import { createMediaContent, createTextContent } from "./message-content";
import type {
    DeviceSummary,
    DeviceVerificationState,
    MatrixMediaRef,
    MatrixSnapshot,
    MediaAsset,
    PersistedMatrixSession,
    TimelineItem,
} from "./types";
import { INITIAL_TIMELINE_ITEM_INDEX, timelineStartIndexAfterPrepend } from "../timeline-window";

type Listener = () => void;
type ShutdownMode = "none" | "stop" | "logout" | "pagehide";

const REMOTE_LOGOUT_TIMEOUT_MS = 10_000;
const REMOTE_REFRESH_TIMEOUT_MS = 30_000;

export interface MatrixLogoutResult {
    remoteSessionEnded: boolean;
}

export interface MatrixPageHideShutdownResult {
    refreshInFlight: boolean;
}

export interface PendingMatrixSessionRevocationResult {
    confirmed: boolean;
}

class DiscardedRefreshSessionError extends Error {
    constructor(readonly revocationConfirmed: boolean) {
        super("The Matrix session was locked during token refresh.");
    }
}

class CommittedRefreshDuringShutdownError extends Error {
    constructor() {
        super("The Matrix session was locked during token refresh.");
    }
}

class MatrixRefreshTimeoutError extends Error {
    constructor() {
        super("The Matrix token refresh timed out.");
    }
}

async function performMatrixSessionRevocation(
    session: Readonly<PersistedMatrixSession>,
): Promise<boolean> {
    if (session.authKind === "oauth" && session.oauth) {
        const oauth = new OAuth2(session.oauth.metadata, {
            clientId: session.oauth.clientId,
            deviceId: session.oauth.deviceId,
            redirectUri: session.oauth.redirectUri,
        });
        const revocations: Promise<void>[] = [];

        if (session.refreshToken) {
            revocations.push(
                Promise.resolve().then(() =>
                    oauth.revokeToken(session.refreshToken!, "refresh_token"),
                ),
            );
        }

        revocations.push(
            Promise.resolve().then(() => oauth.revokeToken(session.accessToken, "access_token")),
        );

        const results = await Promise.allSettled(revocations);

        return results.every((result) => result.status === "fulfilled");
    }

    const logoutClient = createClient({
        baseUrl: assertAllowedHomeserverUrl(session.baseUrl),
        accessToken: session.accessToken,
        disableVoip: true,
        localTimeoutMs: REMOTE_LOGOUT_TIMEOUT_MS,
        store: new MemoryStore(),
    });

    await logoutClient.logout();

    return true;
}

async function boundedMatrixSessionRevocation(
    operation: () => Promise<boolean>,
    timeoutMs: number,
): Promise<PendingMatrixSessionRevocationResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
        const confirmed = await Promise.race([
            operation().catch(() => false),
            new Promise<boolean>((resolve) => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);

        return { confirmed: confirmed === true };
    } catch {
        return { confirmed: false };
    } finally {
        if (timeout !== undefined) {
            clearTimeout(timeout);
        }
    }
}

export function revokePendingMatrixSession(
    session: Readonly<PersistedMatrixSession>,
): Promise<PendingMatrixSessionRevocationResult> {
    return boundedMatrixSessionRevocation(
        () => performMatrixSessionRevocation(session),
        REMOTE_LOGOUT_TIMEOUT_MS,
    );
}

export class MatrixAlreadyOpenError extends Error {
    constructor() {
        super("Sub-Etha is already tuned to this account in another tab.");
    }
}

export class MatrixOwnershipUnavailableError extends Error {
    constructor() {
        super("This browser cannot safely own the persistent Matrix encryption store.");
    }
}

export class MatrixSessionRevocationUnconfirmedError extends Error {
    readonly remoteSessionEnded = false;

    constructor(cause: Error) {
        super(`${cause.message} Newly issued remote credentials could not be confirmed revoked.`, {
            cause,
        });
        this.name = "MatrixSessionRevocationUnconfirmedError";
    }
}

function stableStoreName(session: PersistedMatrixSession): string {
    return `${session.userId}-${session.deviceId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function emptySnapshot(session: PersistedMatrixSession): MatrixSnapshot {
    return {
        connection: "starting",
        rooms: [],
        activeRoomId: null,
        timeline: [],
        timelineStartIndex: INITIAL_TIMELINE_ITEM_INDEX,
        typingNames: [],
        loadingHistory: false,
        hasMoreHistory: false,
        error: null,
        userId: session.userId,
        displayName: session.userId,
        avatarMxcUrl: null,
        deviceId: session.deviceId,
        verification: null,
    };
}

function hasMoreRoomHistory(room: Room | null | undefined): boolean {
    const oldestState = room?.getLiveTimeline().getState(EventTimeline.BACKWARDS);

    return Boolean(oldestState && oldestState.paginationToken !== null);
}

interface ActiveVerification {
    request: VerificationRequest;
    client: MatrixClient;
    lifecycleGeneration: number;
    direction: "incoming" | "outgoing";
    verifierStarted: boolean;
    verifier: Verifier | null;
    sasCallbacks: ShowSasCallbacks | null;
    requestChange: () => void;
    showSas: ((callbacks: ShowSasCallbacks) => void) | null;
}

interface TransientRecoverySetup {
    generated: GeneratedSecretStorageKey;
}

interface MediaCacheEntry<T> {
    promise: Promise<T>;
    value?: T;
    byteLength: number;
    lastUsed: number;
    settled: boolean;
    released: boolean;
    controller?: AbortController;
    alias?: string;
}

interface PosterAsset {
    url: string;
    byteLength: number;
}

interface MediaRequestOptions {
    width?: number;
    height?: number;
    resizeMethod?: "crop" | "scale";
    cacheKey?: string;
    expectedKind?: MediaExpectedKind;
    signal?: AbortSignal;
}

interface PreparedImageFile {
    file: File;
    bytes: ArrayBuffer;
    safety: ReturnType<typeof assertSafeImageBytes>;
}

interface MediaConfigState {
    client: MatrixClient;
    generation: number;
    uploadSize: number | null;
}

async function acquireExclusiveLock(name: string): Promise<(() => void) | null> {
    if (
        typeof navigator === "undefined" ||
        !("locks" in navigator) ||
        typeof navigator.locks?.request !== "function"
    ) {
        throw new MatrixOwnershipUnavailableError();
    }

    let releaseLock: (() => void) | undefined;
    let resolveAcquired: (acquired: boolean) => void = () => undefined;
    let rejectAcquired: (error: unknown) => void = () => undefined;
    const acquired = new Promise<boolean>((resolve, reject) => {
        resolveAcquired = resolve;
        rejectAcquired = reject;
    });
    const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });

    void navigator.locks
        .request(name, { ifAvailable: true }, async (lock) => {
            resolveAcquired(Boolean(lock));

            if (lock) {
                await held;
            }
        })
        .catch(rejectAcquired);

    if (!(await acquired)) {
        return null;
    }

    return () => releaseLock?.();
}

async function messageInfo(
    file: File,
    imageSafety?: ReturnType<typeof assertSafeImageBytes>,
): Promise<Record<string, unknown>> {
    const info: Record<string, unknown> = {
        size: file.size,
        mimetype: file.type || "application/octet-stream",
    };
    const dimensions = imageSafety ?? (await imageDimensions(file));

    if (dimensions.width) {
        info.w = dimensions.width;
    }

    if (dimensions.height) {
        info.h = dimensions.height;
    }

    return info;
}

export function mediaAuthorizationHeaders(
    url: string,
    homeserverUrl: string,
    accessToken: string | null,
): HeadersInit | undefined {
    if (!accessToken) {
        return undefined;
    }

    if (new URL(url).origin !== new URL(homeserverUrl).origin) {
        throw new Error("Refusing to send Matrix credentials to an unexpected media host.");
    }

    return { Authorization: `Bearer ${accessToken}` };
}

export function shouldTryLegacyMedia(status: number): boolean {
    return [400, 404, 405, 501].includes(status);
}

export function findOwnReactionEventId(
    timeline: TimelineItem[],
    eventId: string,
    key: string,
): string | null {
    return (
        timeline
            .find((item) => item.id === eventId)
            ?.reactions.find((reaction) => reaction.key === key && reaction.mine)?.ownEventId ??
        null
    );
}

export class MatrixService {
    private client: MatrixClient | null = null;
    private store: MemoryStore | null = null;
    private lease: SessionLease | null;
    private snapshot: MatrixSnapshot;
    private listeners = new Set<Listener>();
    private releaseLock: (() => void) | null = null;
    private releaseVaultLock: (() => void) | null = null;
    private startTask: Promise<void> | null = null;
    private refreshTask: Promise<{
        accessToken: string;
        refreshToken?: string;
        expiry?: Date;
    }> | null = null;
    private logoutTask: Promise<MatrixLogoutResult> | null = null;
    private pendingStopReleaseTask: Promise<void> | null = null;
    private pageHideReleaseTask: Promise<void> | null = null;
    private pageHideRefreshInFlight = false;
    private invalidationReported = false;
    private revocationUncertaintyReported = false;
    private refreshSessionEndUncertain = false;
    private lifecycleGeneration = 0;
    private shutdownMode: ShutdownMode = "none";
    private started = false;
    private readonly remoteLogoutTimeoutMs = REMOTE_LOGOUT_TIMEOUT_MS;
    private readonly remoteRefreshTimeoutMs = REMOTE_REFRESH_TIMEOUT_MS;
    private activeUploadControllers = new Set<AbortController>();
    private readonly mediaGate = new MediaOperationGate();
    private mediaAssets = new Map<string, MediaCacheEntry<MediaAsset>>();
    private mediaAssetKeys = new WeakMap<object, string>();
    private gifPosters = new Map<string, MediaCacheEntry<PosterAsset | null>>();
    private mediaAliases = new Map<string, Set<string>>();
    private mediaInvalidationGeneration = 0;
    private mediaConfigTask: Promise<MediaConfigState> | null = null;
    private mediaConfigTaskClient: MatrixClient | null = null;
    private mediaConfigTaskGeneration = -1;
    private mediaConfigState: MediaConfigState | null = null;
    private mediaCacheBytes = 0;
    private mediaCacheClock = 0;
    private secretStorageKey: [string, Uint8Array<ArrayBuffer>] | null = null;
    private rustCryptoStorageKey: Uint8Array<ArrayBuffer> | null = null;
    private transientRecoverySetups = new Set<TransientRecoverySetup>();
    private activeVerification: ActiveVerification | null = null;
    private derivedRefreshFrame: number | null = null;
    private pendingTimelineRefresh = false;
    private paginatingRoomId: string | null = null;
    private paginationRequestId = 0;
    private readMarkerTargets = new Map<string, { event: MatrixEvent; eventId: string }>();
    private readMarkerTasks = new Map<string, Promise<void>>();
    private lastReadEventIds = new Map<string, string>();
    private stopped = false;
    private readonly takeoverStorageKey = "sub-etha-account-takeover";

    constructor(
        lease: SessionLease,
        private readonly onSessionInvalidated?: (error: Error) => void,
    ) {
        this.lease = lease;
        this.snapshot = emptySnapshot(lease.session);
    }

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): MatrixSnapshot => this.snapshot;

    private emit(next: Partial<MatrixSnapshot> = {}, allowWhenStopped = false): void {
        if (this.stopped && !allowWhenStopped) {
            return;
        }

        this.snapshot = { ...this.snapshot, ...next };

        for (const listener of this.listeners) {
            listener();
        }
    }

    private requireClient(): MatrixClient {
        if (!this.client) {
            throw new Error("The Matrix client is not ready yet.");
        }

        return this.client;
    }

    private requireLease(): SessionLease {
        if (!this.lease) {
            throw new Error("The unlocked Matrix session is no longer available.");
        }

        return this.lease;
    }

    private refreshTokens(refreshToken: string) {
        if (this.refreshTask) {
            return this.refreshTask;
        }

        const task = this.performTokenRefresh(refreshToken);
        const tracked = task.finally(() => {
            if (this.refreshTask === tracked) {
                this.refreshTask = null;
            }
        });

        this.refreshTask = tracked;

        return tracked;
    }

    private async performTokenRefresh(refreshToken: string) {
        if (this.stopped) {
            throw new Error("The Matrix session was locked before token refresh could begin.");
        }

        const lease = this.requireLease();
        const session = lease.session;
        const baseUrl = assertAllowedHomeserverUrl(session.baseUrl);
        let nextSession: PersistedMatrixSession;

        if (session.authKind === "oauth" && session.oauth) {
            const oauth = new OAuth2(session.oauth.metadata, {
                clientId: session.oauth.clientId,
                deviceId: session.oauth.deviceId,
                redirectUri: session.oauth.redirectUri,
            });
            const toNextSession = (
                response: Awaited<ReturnType<OAuth2["performRefreshTokenGrant"]>>,
            ): PersistedMatrixSession => ({
                ...session,
                baseUrl,
                accessToken: response.access_token,
                refreshToken: response.refresh_token ?? refreshToken,
                expiresAt: response.expires_in
                    ? Date.now() + response.expires_in * 1000
                    : undefined,
            });
            const response = await this.awaitRemoteRefresh(
                oauth.performRefreshTokenGrant(refreshToken),
                (lateResponse) => this.revokeDiscardedRefreshSession(toNextSession(lateResponse)),
            );

            nextSession = toNextSession(response);
        } else {
            const toNextSession = (response: {
                access_token: string;
                refresh_token?: string;
                expires_in_ms: number;
            }): PersistedMatrixSession => ({
                ...session,
                baseUrl,
                accessToken: response.access_token,
                refreshToken: response.refresh_token ?? refreshToken,
                expiresAt: Date.now() + response.expires_in_ms,
            });
            const response = await this.awaitRemoteRefresh(
                createClient({
                    baseUrl,
                    disableVoip: true,
                    store: new MemoryStore(),
                }).refreshToken(refreshToken),
                (lateResponse) => this.revokeDiscardedRefreshSession(toNextSession(lateResponse)),
            );

            nextSession = toNextSession(response);
        }

        if (this.stopped) {
            const revocation = await this.revokeDiscardedRefreshSession(nextSession);

            throw new DiscardedRefreshSessionError(revocation.confirmed);
        }

        try {
            await lease.reseal(nextSession, "token-refresh");
        } catch (error) {
            const resealError =
                error instanceof Error
                    ? error
                    : new Error("The refreshed Matrix session could not be sealed.");
            const revocation = await this.revokeDiscardedRefreshSession(nextSession);

            if (this.stopped) {
                throw new DiscardedRefreshSessionError(revocation.confirmed);
            }

            const invalidation = revocation.confirmed
                ? resealError
                : new MatrixSessionRevocationUnconfirmedError(resealError);

            this.invalidateSession(invalidation);

            throw invalidation;
        }

        if (this.stopped || this.lease !== lease) {
            // The successful reseal is serialized before logout's tombstone, so the final
            // session captured by deleteRecord includes these credentials and logout revokes
            // them as its authoritative snapshot.
            throw new CommittedRefreshDuringShutdownError();
        }

        return {
            accessToken: nextSession.accessToken,
            refreshToken: nextSession.refreshToken,
            expiry: nextSession.expiresAt ? new Date(nextSession.expiresAt) : undefined,
        };
    }

    private async awaitRemoteRefresh<T>(
        operation: Promise<T>,
        onLateFulfilled: (response: T) => Promise<unknown>,
    ): Promise<T> {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const observedOperation = operation.then((response) => {
            if (timedOut) {
                // A timed-out token endpoint request cannot be cancelled reliably. If it
                // eventually returns credentials, revoke that discarded session without ever
                // publishing or persisting it.
                void Promise.resolve()
                    .then(() => onLateFulfilled(response))
                    .catch(() => undefined);
            }

            return response;
        });

        try {
            return await Promise.race([
                observedOperation,
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => {
                        timedOut = true;
                        this.refreshSessionEndUncertain = true;
                        const invalidation = new MatrixSessionRevocationUnconfirmedError(
                            new MatrixRefreshTimeoutError(),
                        );

                        // The token endpoint may have issued rotated credentials even though
                        // its response missed our deadline. Lock immediately and surface the
                        // typed uncertainty signal while this document can still persist it.
                        // A response that arrives later is still revoked best-effort above.
                        this.invalidateSession(invalidation);
                        reject(invalidation);
                    }, this.remoteRefreshTimeoutMs);
                }),
            ]);
        } finally {
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
        }
    }

    private revokeDiscardedRefreshSession(
        session: Readonly<PersistedMatrixSession>,
    ): Promise<PendingMatrixSessionRevocationResult> {
        return this.endRemoteSessionWithinDeadline(session);
    }

    start(): Promise<void> {
        if (this.startTask) {
            return this.startTask;
        }

        if (this.started) {
            return Promise.resolve();
        }

        if (this.stopped) {
            return Promise.reject(new Error("A locked Matrix service cannot be restarted."));
        }

        let lease: SessionLease;

        try {
            lease = this.requireLease();
        } catch (error) {
            return Promise.reject(error);
        }

        const generation = ++this.lifecycleGeneration;
        const tracked = this.performStart(lease, generation).finally(() => {
            if (this.startTask === tracked) {
                this.startTask = null;
            }

            if (this.stopped) {
                this.closeRuntime();

                if (this.shutdownMode === "stop" && !this.pendingStopReleaseTask) {
                    this.disposeLeaseAndReleaseLock();
                }
            }
        });

        this.startTask = tracked;

        return tracked;
    }

    private assertStartupActive(lease: SessionLease, generation: number): void {
        if (this.stopped || this.lease !== lease || this.lifecycleGeneration !== generation) {
            throw new Error("Matrix startup was cancelled because the session was locked.");
        }
    }

    private isClientLifecycleActive(client: MatrixClient, generation: number): boolean {
        return !this.stopped && this.lifecycleGeneration === generation && this.client === client;
    }

    private assertClientLifecycleActive(client: MatrixClient, generation: number): void {
        if (!this.isClientLifecycleActive(client, generation)) {
            throw new Error("The Matrix operation was cancelled because the session was locked.");
        }
    }

    private cacheSecretStorageKey(
        client: MatrixClient,
        generation: number,
        keyId: string,
        key: Uint8Array<ArrayBuffer>,
    ): void {
        if (!this.isClientLifecycleActive(client, generation)) {
            key.fill(0);

            return;
        }

        const cachedKey = new Uint8Array(key);

        this.secretStorageKey?.[1].fill(0);
        this.secretStorageKey = [keyId, cachedKey];
    }

    private clearTransientRecoverySetup(material: TransientRecoverySetup): void {
        try {
            material.generated.privateKey.fill(0);
        } catch {
            /* detached buffers no longer expose readable key bytes */
        }

        try {
            material.generated.privateKey = new Uint8Array(0);
        } catch {
            /* SDK-owned records may not expose writable properties */
        }

        try {
            material.generated.encodedPrivateKey = undefined;
            Reflect.deleteProperty(material.generated, "encodedPrivateKey");
        } catch {
            /* SDK-owned records may not expose writable properties */
        }

        this.transientRecoverySetups.delete(material);
    }

    private clearTransientRecoverySetups(): void {
        for (const material of this.transientRecoverySetups) {
            this.clearTransientRecoverySetup(material);
        }
    }

    private async performStart(lease: SessionLease, generation: number): Promise<void> {
        try {
            const session = lease.session;
            const baseUrl = assertAllowedHomeserverUrl(session.baseUrl);
            const releaseVaultLock = await acquireExclusiveLock(SESSION_VAULT_LOCK_NAME);

            if (!releaseVaultLock) {
                throw new MatrixAlreadyOpenError();
            }

            this.releaseVaultLock = releaseVaultLock;
            this.assertStartupActive(lease, generation);
            const releaseLock = await acquireExclusiveLock(
                `sub-etha-matrix-${stableStoreName(session)}`,
            );

            if (!releaseLock) {
                throw new MatrixAlreadyOpenError();
            }

            this.releaseLock = releaseLock;
            this.assertStartupActive(lease, generation);
            await lease.assertCurrent();
            this.assertStartupActive(lease, generation);

            const store = new MemoryStore();
            const scheduler = new MatrixScheduler();
            const client = createClient({
                baseUrl,
                userId: session.userId,
                deviceId: session.deviceId,
                accessToken: session.accessToken,
                refreshToken: session.refreshToken,
                tokenRefreshFunction: (token) => this.refreshTokens(token),
                store,
                scheduler,
                timelineSupport: true,
                disableVoip: true,
                localTimeoutMs: 30_000,
                verificationMethods: ["m.sas.v1"],
                cryptoCallbacks: {
                    getSecretStorageKey: async ({ keys }) => {
                        if (
                            this.isClientLifecycleActive(client, generation) &&
                            this.secretStorageKey &&
                            keys[this.secretStorageKey[0]]
                        ) {
                            return this.secretStorageKey;
                        }

                        return null;
                    },
                    cacheSecretStorageKey: (keyId, _keyInfo, key) => {
                        this.cacheSecretStorageKey(client, generation, keyId, key);
                    },
                },
            });

            this.store = store;
            this.client = client;
            this.mediaConfigState = null;

            await store.startup();
            this.assertStartupActive(lease, generation);
            const cryptoStorageKey = base64UrlToBytes(session.cryptoStorageKey);

            this.rustCryptoStorageKey = cryptoStorageKey;

            try {
                await client.initRustCrypto({
                    useIndexedDB: true,
                    cryptoDatabasePrefix: lease.cryptoDatabasePrefix,
                    storageKey: cryptoStorageKey,
                });
            } finally {
                this.clearRustCryptoStorageKey(cryptoStorageKey);
            }

            this.assertStartupActive(lease, generation);
            client.on(ClientEvent.Sync, this.handleSync);
            client.on(MatrixEventEvent.Decrypted, this.handleDecrypted);
            client.on(RoomEvent.Timeline, this.handleTimeline);
            client.on(RoomEvent.Name, this.handleRoomChange);
            client.on(RoomEvent.Receipt, this.handleRoomChange);
            client.on(RoomEvent.MyMembership, this.handleRoomChange);
            client.on(RoomMemberEvent.Typing, this.handleTyping);
            client.on(CryptoEvent.VerificationRequestReceived, this.handleIncomingVerification);
            window.addEventListener("storage", this.handleTakeoverRequest);

            try {
                await client.startClient({
                    initialSyncLimit: 30,
                    lazyLoadMembers: true,
                    pendingEventOrdering: "chronological" as never,
                    disablePresence: true,
                    clientWellKnownPollPeriod: 6 * 60 * 60,
                });
                this.assertStartupActive(lease, generation);
            } catch (error) {
                // closeRuntime may already have detached this client during logout. Stop the
                // local startup reference again in case startClient resumed after that scrub.
                client.stopClient();

                throw error;
            }

            this.started = true;
            this.refreshDerivedState();
            void this.refreshOwnProfile();
        } catch (error) {
            this.stopped = true;
            this.lifecycleGeneration += 1;

            if (this.shutdownMode === "none") {
                this.shutdownMode = "stop";
            }

            this.scrubSnapshot(this.snapshot.error);
            this.closeRuntime();

            throw error;
        }
    }

    private handleSync = (state: SyncState): void => {
        if (this.stopped) {
            return;
        }

        if (state === SyncState.Prepared || state === SyncState.Syncing) {
            this.emit({ connection: "ready", error: null });
        } else if (state === SyncState.Catchup || state === SyncState.Reconnecting) {
            this.emit({ connection: "catching-up" });
        } else if (state === SyncState.Error) {
            this.emit({ connection: navigator.onLine ? "error" : "offline" });
        } else if (state === SyncState.Stopped) {
            this.emit({ connection: "idle" });
        }

        this.refreshDerivedState();

        if (
            (state === SyncState.Prepared || state === SyncState.Syncing) &&
            this.snapshot.activeRoomId &&
            document.visibilityState === "visible"
        ) {
            void this.markRoomRead(this.snapshot.activeRoomId);
        }
    };

    private handleTimeline = (
        _event: MatrixEvent,
        room: Room | undefined,
        toStartOfTimeline?: boolean,
    ): void => {
        if (this.stopped) {
            return;
        }

        const active = room?.roomId === this.snapshot.activeRoomId;

        if (active && toStartOfTimeline && room?.roomId === this.paginatingRoomId) {
            return;
        }

        this.refreshDerivedState(active);

        if (active && room && document.visibilityState === "visible") {
            void this.markRoomRead(room.roomId);
        }
    };

    private handleDecrypted = (event: MatrixEvent): void => {
        if (this.stopped) {
            return;
        }

        this.scheduleDerivedRefresh(event.getRoomId() === this.snapshot.activeRoomId);
    };

    private handleRoomChange = (): void => {
        if (!this.stopped) {
            this.refreshDerivedState(true);
        }
    };

    private handleTyping = (): void => {
        if (!this.stopped) {
            this.refreshTyping();
        }
    };

    private scheduleDerivedRefresh(includeTimeline: boolean): void {
        this.pendingTimelineRefresh ||= includeTimeline;

        if (this.derivedRefreshFrame !== null) {
            return;
        }

        this.derivedRefreshFrame = window.requestAnimationFrame(() => {
            this.derivedRefreshFrame = null;
            const refreshTimeline = this.pendingTimelineRefresh;

            this.pendingTimelineRefresh = false;

            if (!this.stopped) {
                this.refreshDerivedState(refreshTimeline);
            }
        });
    }

    private async decryptRoomTimeline(room: Room): Promise<void> {
        try {
            await room.decryptAllEvents();
        } catch {
            // Individual events expose their failure state and will retry when keys arrive.
        } finally {
            if (!this.stopped) {
                this.scheduleDerivedRefresh(room.roomId === this.snapshot.activeRoomId);
            }
        }
    }

    private handleTakeoverRequest = (event: StorageEvent): void => {
        if (event.key !== this.takeoverStorageKey || !event.newValue || this.stopped) {
            return;
        }

        const error = new Error("This receiver was safely locked for another tab.");

        this.invalidateSession(error);
    };

    private invalidateSession(error: Error): void {
        if (this.invalidationReported) {
            return;
        }

        this.invalidationReported = true;

        if (error instanceof MatrixSessionRevocationUnconfirmedError) {
            this.revocationUncertaintyReported = true;
        }

        this.stopWithError(error.message);

        try {
            this.onSessionInvalidated?.(error);
        } catch {
            /* session invalidation is already complete */
        }
    }

    private reportRevocationUncertainty(cause: Error): void {
        if (this.revocationUncertaintyReported) {
            return;
        }

        this.revocationUncertaintyReported = true;
        const error =
            cause instanceof MatrixSessionRevocationUnconfirmedError
                ? cause
                : new MatrixSessionRevocationUnconfirmedError(cause);

        try {
            this.onSessionInvalidated?.(error);
        } catch {
            /* the local runtime is already closed; warning persistence is best-effort */
        }
    }

    private verificationState(
        context: ActiveVerification,
        stage: DeviceVerificationState["stage"],
        next: Partial<DeviceVerificationState> = {},
    ): DeviceVerificationState {
        return {
            transactionId: context.request.transactionId ?? null,
            direction: context.direction,
            otherUserId: context.request.otherUserId,
            otherDeviceId: context.request.otherDeviceId ?? null,
            stage,
            emojis: [],
            ...next,
        };
    }

    private handleIncomingVerification = (request: VerificationRequest): void => {
        if (!request.isSelfVerification || !request.pending || this.stopped) {
            return;
        }

        if (this.activeVerification?.request === request) {
            return;
        }

        if (this.activeVerification?.request.pending) {
            void request.cancel();

            return;
        }

        const context = this.bindVerification(request, "incoming");

        this.emit({
            verification: this.verificationState(context, "incoming", {
                message: "Another Sub-Etha receiver wants to verify this device.",
            }),
        });
        this.handleVerificationChange(request);
    };

    private bindVerification(
        request: VerificationRequest,
        direction: "incoming" | "outgoing",
    ): ActiveVerification {
        const client = this.requireClient();

        this.releaseVerificationContext();
        const requestChange = () => this.handleVerificationChange(request);
        const context: ActiveVerification = {
            request,
            client,
            lifecycleGeneration: this.lifecycleGeneration,
            direction,
            verifierStarted: false,
            verifier: null,
            sasCallbacks: null,
            requestChange,
            showSas: null,
        };

        this.activeVerification = context;
        request.on(VerificationRequestEvent.Change, requestChange);

        return context;
    }

    private handleVerificationChange(request: VerificationRequest): void {
        const context = this.activeVerification;

        if (!context || context.request !== request) {
            return;
        }

        if (request.phase === VerificationPhase.Cancelled) {
            this.finishVerification(
                "cancelled",
                "The verification was cancelled on one of your devices.",
            );

            return;
        }

        if (request.phase === VerificationPhase.Done) {
            this.finishVerification(
                "complete",
                "These two Sub-Etha receivers now trust one another.",
            );

            return;
        }

        if (request.phase === VerificationPhase.Started) {
            void this.runVerifier(context);

            return;
        }

        if (request.phase === VerificationPhase.Ready && context.direction === "outgoing") {
            void this.runVerifier(context);

            return;
        }

        const current = this.snapshot.verification;

        if (current && current.stage !== "comparing") {
            this.emit({
                verification: this.verificationState(context, current.stage, {
                    message: current.message,
                }),
            });
        }
    }

    private async runVerifier(context: ActiveVerification): Promise<void> {
        if (this.activeVerification !== context || context.verifierStarted) {
            return;
        }

        context.verifierStarted = true;

        try {
            const verifier =
                context.request.verifier ??
                (context.request.phase === VerificationPhase.Ready
                    ? await context.request.startVerification("m.sas.v1")
                    : null);

            if (!verifier) {
                context.verifierStarted = false;

                return;
            }

            if (
                this.activeVerification !== context ||
                !this.isClientLifecycleActive(context.client, context.lifecycleGeneration)
            ) {
                verifier.cancel(
                    new Error("Verification was cancelled because the Matrix session was locked."),
                );

                return;
            }

            context.verifier = verifier;

            const showSas = (callbacks: ShowSasCallbacks) => {
                if (
                    this.activeVerification !== context ||
                    !this.isClientLifecycleActive(context.client, context.lifecycleGeneration)
                ) {
                    callbacks.cancel();

                    return;
                }

                context.sasCallbacks = callbacks;
                this.emit({
                    verification: this.verificationState(context, "comparing", {
                        emojis: callbacks.sas.emoji ?? [],
                        decimals: callbacks.sas.decimal,
                        message:
                            "Compare this sequence on both devices. Order matters; improbable hats do not.",
                    }),
                });
            };

            context.showSas = showSas;
            verifier.on(VerifierEvent.ShowSas, showSas);
            this.emit({
                verification: this.verificationState(context, "waiting", {
                    message: "The devices are negotiating a short, reassuring sequence of emoji.",
                }),
            });
            const currentSas = verifier.getShowSasCallbacks();

            if (currentSas) {
                showSas(currentSas);
            }

            await verifier.verify();

            if (
                this.activeVerification === context &&
                this.isClientLifecycleActive(context.client, context.lifecycleGeneration)
            ) {
                this.finishVerification(
                    "complete",
                    "These two Sub-Etha receivers now trust one another.",
                );
            }
        } catch (error) {
            if (this.activeVerification !== context) {
                return;
            }

            if (context.request.phase === VerificationPhase.Cancelled) {
                this.finishVerification(
                    "cancelled",
                    "The verification was cancelled on one of your devices.",
                );
            } else {
                this.finishVerification("error", humanizeMatrixError(error));
            }
        }
    }

    private releaseVerificationContext(cancel = false): void {
        const context = this.activeVerification;

        if (!context) {
            return;
        }

        context.request.off(VerificationRequestEvent.Change, context.requestChange);

        if (context.verifier && context.showSas) {
            context.verifier.off(VerifierEvent.ShowSas, context.showSas);
        }

        this.activeVerification = null;

        if (cancel) {
            try {
                if (context.sasCallbacks) {
                    context.sasCallbacks.cancel();
                } else if (context.verifier && !context.verifier.hasBeenCancelled) {
                    context.verifier.cancel(
                        new Error(
                            "Verification was cancelled because the Matrix session was locked.",
                        ),
                    );
                } else if (context.request.pending) {
                    void context.request.cancel().catch(() => undefined);
                }
            } catch {
                /* local verification state is already released */
            }
        }
    }

    private finishVerification(stage: "complete" | "cancelled" | "error", message: string): void {
        const context = this.activeVerification;

        if (!context) {
            return;
        }

        const state = this.verificationState(context, stage, { message });

        this.releaseVerificationContext();
        this.emit({ verification: state });
    }

    private refreshDerivedState(includeTimeline = true): void {
        const client = this.client;

        if (!client) {
            return;
        }

        const rooms = normalizeRooms(client);
        let activeRoomId = this.snapshot.activeRoomId;

        if (activeRoomId && !rooms.some((room) => room.id === activeRoomId)) {
            activeRoomId = null;
        }

        const activeRoomChanged = activeRoomId !== this.snapshot.activeRoomId;

        if (activeRoomChanged) {
            this.paginationRequestId += 1;
            this.paginatingRoomId = null;
        }

        const room = activeRoomId ? client.getRoom(activeRoomId) : null;
        const shouldRefreshTimeline = includeTimeline && room?.roomId !== this.paginatingRoomId;

        this.emit({
            rooms,
            activeRoomId,
            hasMoreHistory: hasMoreRoomHistory(room),
            loadingHistory: activeRoomChanged ? false : this.snapshot.loadingHistory,
            timeline:
                shouldRefreshTimeline && room
                    ? normalizeTimeline(room, client)
                    : this.snapshot.timeline,
        });
        this.refreshTyping();
    }

    private async refreshOwnProfile(): Promise<void> {
        const client = this.client;
        const userId = client?.getUserId();

        if (!client || !userId) {
            return;
        }

        try {
            const profile = await client.getProfileInfo(userId);

            this.emit({
                displayName: profile.displayname || userId,
                avatarMxcUrl: profile.avatar_url ?? null,
            });
        } catch {
            const user = client.getUser(userId);

            this.emit({
                displayName: user?.displayName || userId,
                avatarMxcUrl: user?.avatarUrl ?? null,
            });
        }
    }

    private refreshTyping(): void {
        const client = this.client;
        const room =
            client && this.snapshot.activeRoomId
                ? client.getRoom(this.snapshot.activeRoomId)
                : null;
        const ownUserId = client?.getUserId();
        const typingNames = room
            ? room
                  .getMembers()
                  .filter((member) => member.typing && member.userId !== ownUserId)
                  .map((member) => member.name || member.userId)
            : [];

        if (typingNames.join("\u0000") !== this.snapshot.typingNames.join("\u0000")) {
            this.emit({ typingNames });
        }
    }

    selectRoom(roomId: string | null): void {
        const client = this.requireClient();
        const room = roomId ? client.getRoom(roomId) : null;

        this.paginationRequestId += 1;
        this.paginatingRoomId = null;
        this.emit({
            activeRoomId: room?.roomId ?? null,
            timeline: room ? normalizeTimeline(room, client) : [],
            timelineStartIndex: INITIAL_TIMELINE_ITEM_INDEX,
            loadingHistory: false,
            hasMoreHistory: hasMoreRoomHistory(room),
            error: null,
        });
        this.refreshTyping();

        if (room) {
            void this.decryptRoomTimeline(room);

            if (document.visibilityState === "visible") {
                void this.markRoomRead(room.roomId);
            }
        }
    }

    clearError(): void {
        if (this.snapshot.error) {
            this.emit({ error: null });
        }
    }

    async paginate(): Promise<void> {
        const client = this.requireClient();
        const room = this.snapshot.activeRoomId ? client.getRoom(this.snapshot.activeRoomId) : null;

        if (!room || this.snapshot.loadingHistory || !this.snapshot.hasMoreHistory) {
            return;
        }

        const roomId = room.roomId;
        const requestId = ++this.paginationRequestId;
        const previousFirstItemId = this.snapshot.timeline[0]?.id ?? null;

        this.paginatingRoomId = roomId;
        this.emit({ loadingHistory: true, error: null });

        try {
            await client.scrollback(room, 40);

            if (requestId !== this.paginationRequestId || roomId !== this.snapshot.activeRoomId) {
                return;
            }

            const timeline = normalizeTimeline(room, client);

            this.emit({
                timeline,
                timelineStartIndex: timelineStartIndexAfterPrepend(
                    this.snapshot.timelineStartIndex,
                    previousFirstItemId,
                    timeline.map((item) => item.id),
                ),
                loadingHistory: false,
                hasMoreHistory: hasMoreRoomHistory(room),
            });
            void this.decryptRoomTimeline(room);
        } catch (error) {
            if (requestId === this.paginationRequestId && roomId === this.snapshot.activeRoomId) {
                this.emit({ loadingHistory: false, error: humanizeMatrixError(error) });
            }
        } finally {
            if (requestId === this.paginationRequestId && this.paginatingRoomId === roomId) {
                this.paginatingRoomId = null;
            }
        }
    }

    async sendText(
        body: string,
        options: { replyTo?: string; editEventId?: string } = {},
    ): Promise<void> {
        const client = this.requireClient();
        const roomId = this.snapshot.activeRoomId;

        if (!roomId || !body.trim()) {
            return;
        }

        const room = client.getRoom(roomId);
        const editedEvent = options.editEventId
            ? room?.findEventById(options.editEventId)
            : undefined;

        if (editedEvent && editedEvent.getSender() !== client.getUserId()) {
            throw new Error("You can only edit your own messages.");
        }

        const editedRelation = editedEvent?.getContent<Record<string, unknown>>()[
            "m.relates_to"
        ] as { "m.in_reply_to"?: { event_id?: string } } | undefined;
        const replyTo = options.replyTo ?? editedRelation?.["m.in_reply_to"]?.event_id;
        const replyUserId = replyTo ? room?.findEventById(replyTo)?.getSender() : undefined;
        const content = createTextContent(body, { ...options, replyTo, replyUserId });

        try {
            await client.sendMessage(roomId, content as never);
        } catch (error) {
            this.emit({ error: humanizeMatrixError(error) });

            throw error;
        }
    }

    private mediaReceiveLimit(expectedKind: MediaExpectedKind = "file"): number {
        return expectedKind === "image" ? MAX_IMAGE_BYTES : MAX_NONIMAGE_MEDIA_BYTES;
    }

    private mediaUploadLimit(encrypted: boolean, image = false, avatar = false): number {
        if (avatar) {
            return MAX_AVATAR_BYTES;
        }

        if (image) {
            return MAX_IMAGE_BYTES;
        }

        return encrypted ? MAX_ENCRYPTED_UPLOAD_BYTES : MAX_PLAIN_UPLOAD_BYTES;
    }

    private async prepareImageFile(source: File, maximumBytes: number): Promise<PreparedImageFile> {
        assertMediaByteLength(source.size, maximumBytes);
        const bytes = await source.arrayBuffer();
        const safety = assertSafeImageBytes(new Uint8Array(bytes));
        const file = new File([bytes], canonicalMediaFileName(source, safety.mimeType), {
            type: safety.mimeType,
            lastModified: source.lastModified || Date.now(),
        });

        return { file, bytes, safety };
    }

    private linkGateAbort(lease: MediaOperationLease, controller: AbortController): () => void {
        const abort = () => {
            if (!controller.signal.aborted) {
                controller.abort(lease.signal.reason);
            }
        };

        lease.signal.addEventListener("abort", abort, { once: true });

        return () => lease.signal.removeEventListener("abort", abort);
    }

    private assertMediaOperationActive(
        client: MatrixClient,
        generation: number,
        lease?: MediaOperationLease,
    ): void {
        this.assertClientLifecycleActive(client, generation);
        lease?.signal.throwIfAborted();
    }

    private assertMediaDeadline(deadlineAt: number): void {
        if (Date.now() >= deadlineAt) {
            throw new MediaTimeoutError();
        }
    }

    private async getMediaUploadConfig(
        client: MatrixClient,
        generation: number,
        signal?: AbortSignal,
    ): Promise<number | null> {
        if (
            this.mediaConfigState?.client === client &&
            this.mediaConfigState.generation === generation
        ) {
            return this.mediaConfigState.uploadSize;
        }

        if (
            this.mediaConfigTask &&
            this.mediaConfigTaskClient === client &&
            this.mediaConfigTaskGeneration === generation
        ) {
            const state = await this.mediaConfigTask;

            this.assertClientLifecycleActive(client, generation);

            return state.uploadSize;
        }

        const task = this.fetchMediaUploadConfig(client, generation, signal).then((uploadSize) => {
            const state = { client, generation, uploadSize };

            if (
                this.client === client &&
                this.lifecycleGeneration === generation &&
                !this.stopped
            ) {
                this.mediaConfigState = state;
            }

            return state;
        });

        this.mediaConfigTask = task;
        this.mediaConfigTaskClient = client;
        this.mediaConfigTaskGeneration = generation;

        try {
            const state = await task;

            this.assertClientLifecycleActive(client, generation);

            return state.uploadSize;
        } finally {
            if (this.mediaConfigTask === task) {
                this.mediaConfigTask = null;
                this.mediaConfigTaskClient = null;
                this.mediaConfigTaskGeneration = -1;
            }
        }
    }

    private async fetchMediaUploadConfig(
        client: MatrixClient,
        generation: number,
        signal?: AbortSignal,
    ): Promise<number | null> {
        if (
            typeof (client as unknown as { getHomeserverUrl?: unknown }).getHomeserverUrl !==
                "function" ||
            typeof (client as unknown as { getAccessToken?: unknown }).getAccessToken !== "function"
        ) {
            return null;
        }

        let baseUrl: string;
        let token: string | null;

        try {
            baseUrl = client.getHomeserverUrl();
            token = client.getAccessToken();
        } catch {
            return null;
        }

        const deadline = Date.now() + 30_000;
        const paths = ["/_matrix/client/v1/media/config", "/_matrix/media/v3/config"];

        for (let index = 0; index < paths.length; index += 1) {
            signal?.throwIfAborted();
            this.assertClientLifecycleActive(client, generation);
            const controller = new AbortController();
            const abort = () => controller.abort(signal?.reason);
            const timeout = setTimeout(
                () => controller.abort(new MediaTimeoutError()),
                Math.max(0, deadline - Date.now()),
            );

            const cleanupRequest = () => {
                clearTimeout(timeout);
                signal?.removeEventListener("abort", abort);
            };

            signal?.addEventListener("abort", abort, { once: true });
            let url: string;

            try {
                url = new URL(paths[index], baseUrl).href;
            } catch {
                cleanupRequest();

                return null;
            }

            let response: Response;

            try {
                response = await fetch(url, {
                    headers: mediaAuthorizationHeaders(url, baseUrl, token),
                    cache: "no-store",
                    signal: controller.signal,
                });
            } catch (error) {
                cleanupRequest();

                if (signal?.aborted) {
                    throw signal.reason ?? error;
                }

                return null;
            }

            try {
                signal?.throwIfAborted();
                this.assertClientLifecycleActive(client, generation);
            } catch (error) {
                await response.body?.cancel().catch(() => undefined);
                cleanupRequest();

                throw error;
            }

            if (response.status === 200) {
                try {
                    const bytes = await readBoundedResponse(response, MAX_MEDIA_CONFIG_BYTES, {
                        signal: controller.signal,
                        deadlineAt: deadline,
                        idleTimeoutMs: MEDIA_IDLE_TIMEOUT_MS,
                    });

                    this.assertMediaDeadline(deadline);
                    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<
                        string,
                        unknown
                    >;
                    const value = parsed["m.upload.size"];

                    return isSafeNonNegativeInteger(value) ? value : null;
                } catch (error) {
                    await response.body?.cancel().catch(() => undefined);

                    if (signal?.aborted) {
                        throw signal.reason ?? error;
                    }

                    return null;
                } finally {
                    cleanupRequest();
                }
            }

            await response.body?.cancel().catch(() => undefined);
            cleanupRequest();

            if (![400, 404, 405, 501].includes(response.status) || index === paths.length - 1) {
                return null;
            }
        }

        return null;
    }

    private async effectiveUploadLimit(
        client: MatrixClient,
        generation: number,
        localLimit: number,
        signal?: AbortSignal,
    ): Promise<number> {
        const serverLimit = await this.getMediaUploadConfig(client, generation, signal);

        this.assertClientLifecycleActive(client, generation);

        return serverLimit === null ? localLimit : Math.min(localLimit, serverLimit);
    }

    private isUploadTooLarge(error: unknown): boolean {
        if (!error || typeof error !== "object") {
            return false;
        }

        const value = error as {
            httpStatus?: unknown;
            errcode?: unknown;
            data?: { errcode?: unknown };
        };

        return (
            value.httpStatus === 413 &&
            (value.errcode === "M_TOO_LARGE" || value.data?.errcode === "M_TOO_LARGE")
        );
    }

    private assertEncryptedMetadata(info: IEncryptedFile): void {
        const source = info as unknown as Record<string, unknown>;
        const key =
            source.key && typeof source.key === "object"
                ? (source.key as Record<string, unknown>)
                : null;
        const hashes =
            source.hashes && typeof source.hashes === "object"
                ? (source.hashes as Record<string, unknown>)
                : null;
        const keyOps = key?.key_ops;

        if (
            !key ||
            !hashes ||
            typeof key.ext !== "boolean" ||
            !Array.isArray(keyOps) ||
            keyOps.length > 16 ||
            keyOps.some((value) => typeof value !== "string")
        ) {
            throw new MediaLimitError("The encrypted attachment metadata is invalid.");
        }

        if (source.v !== undefined) {
            boundedMediaString(source.v, 32);
        }

        if (source.url !== undefined) {
            boundedMediaString(source.url, 4096);
        }

        boundedMediaString(source.iv, 256);
        boundedMediaString(hashes.sha256, 256);
        boundedMediaString(key.alg, 128);
        boundedMediaString(key.kty, 128);
        boundedMediaString(key.k, 4096);
        keyOps.forEach((value) => boundedMediaString(value, 128));
    }

    private async uploadMedia(
        client: MatrixClient,
        generation: number,
        lease: MediaOperationLease,
        controller: AbortController,
        body: Blob,
        options: Parameters<MatrixClient["uploadContent"]>[1],
    ) {
        this.assertMediaOperationActive(client, generation, lease);

        try {
            return await client.uploadContent(body, {
                ...options,
                abortController: controller,
            });
        } catch (error) {
            if (this.isUploadTooLarge(error)) {
                throw new MediaLimitError("The homeserver rejected this attachment as too large.");
            }

            throw error;
        }
    }

    async sendFile(
        sourceFile: File,
        options: { caption?: string; replyTo?: string } = {},
        onProgress?: (percentage: number) => void,
        onCancellable?: (cancel: (() => void) | null) => void,
    ): Promise<void> {
        const client = this.requireClient();
        const roomId = this.snapshot.activeRoomId;

        if (!roomId) {
            return;
        }

        const room = client.getRoom(roomId);

        if (!room) {
            return;
        }

        const generation = this.lifecycleGeneration;
        const abortController = new AbortController();
        const caption =
            options.caption === undefined ? undefined : boundedMediaString(options.caption, 4096);
        const replyTo =
            options.replyTo === undefined ? undefined : boundedMediaString(options.replyTo, 1024);
        const candidate = isImageUploadCandidate(sourceFile);
        const encrypted = room.hasEncryptionStateEvent();
        const localLimit = candidate ? MAX_IMAGE_BYTES : this.mediaUploadLimit(encrypted);

        assertMediaByteLength(sourceFile.size, localLimit);
        this.activeUploadControllers.add(abortController);
        onCancellable?.(() => abortController.abort());
        let lease: MediaOperationLease | null = null;
        let unlinkGateAbort: () => void = () => undefined;

        try {
            lease = await this.mediaGate.acquire(sourceFile.size, abortController.signal);
            unlinkGateAbort = this.linkGateAbort(lease, abortController);
            this.assertMediaOperationActive(client, generation, lease);
            const limit = await this.effectiveUploadLimit(
                client,
                generation,
                localLimit,
                lease.signal,
            );

            this.assertMediaOperationActive(client, generation, lease);
            assertMediaByteLength(sourceFile.size, limit);
            const prepared = candidate
                ? await this.prepareImageFile(sourceFile, MAX_IMAGE_BYTES)
                : null;

            this.assertMediaOperationActive(client, generation, lease);
            const file = prepared?.file ?? (await normalizeMediaFile(sourceFile));

            this.assertMediaOperationActive(client, generation, lease);
            assertMediaByteLength(file.size, limit);
            let uploadBody: Blob = file;
            let encryptedFile: IEncryptedFile | undefined;

            if (encrypted) {
                const fileBuffer = prepared?.bytes ?? (await file.arrayBuffer());

                this.assertMediaOperationActive(client, generation, lease);
                const result = await encryptAttachment(fileBuffer);

                this.assertMediaOperationActive(client, generation, lease);
                this.assertEncryptedMetadata(result.info);
                uploadBody = new Blob([result.data], { type: "application/octet-stream" });
                encryptedFile = result.info;
            }

            assertMediaByteLength(uploadBody.size, limit);
            this.assertMediaOperationActive(client, generation, lease);
            const upload = await this.uploadMedia(
                client,
                generation,
                lease,
                abortController,
                uploadBody,
                {
                    name: file.name,
                    type: encrypted ? "application/octet-stream" : file.type,
                    progressHandler: (progress) => {
                        if (
                            abortController.signal.aborted ||
                            this.stopped ||
                            this.lifecycleGeneration !== generation ||
                            this.client !== client
                        ) {
                            return;
                        }

                        const total = progress.total || file.size;

                        onProgress?.(total ? Math.round((progress.loaded / total) * 100) : 0);
                    },
                },
            );

            this.assertMediaOperationActive(client, generation, lease);
            const info = await messageInfo(file, prepared?.safety);

            this.assertMediaOperationActive(client, generation, lease);
            const content = createMediaContent({
                fileName: file.name,
                mimeType: file.type,
                contentUri: upload.content_uri,
                info,
                caption,
                replyTo,
                encryptedFile: encryptedFile as unknown as Record<string, unknown> | undefined,
            });

            this.assertMediaOperationActive(client, generation, lease);
            await client.sendMessage(roomId, content as never);
            this.assertMediaOperationActive(client, generation, lease);
        } finally {
            unlinkGateAbort();
            this.activeUploadControllers.delete(abortController);
            onCancellable?.(null);
            lease?.release();
        }
    }

    private assertUploadActive(
        client: MatrixClient,
        generation: number,
        signal?: AbortSignal,
    ): void {
        if (
            signal?.aborted ||
            this.stopped ||
            this.lifecycleGeneration !== generation ||
            this.client !== client
        ) {
            throw new DOMException("The attachment upload was cancelled.", "AbortError");
        }
    }

    private mediaCacheAlias(media: MatrixMediaRef, cacheKey?: string): string {
        return `${boundedMediaString(cacheKey ?? media.mxcUrl, 4096)}|${boundedMediaString(media.mxcUrl, 4096)}`;
    }

    private async mediaCacheKey(
        media: MatrixMediaRef,
        options: MediaRequestOptions,
    ): Promise<string> {
        const encrypted = Boolean(media.encryptedFile);
        const digest = encrypted ? await encryptedMediaDigest(media.encryptedFile) : null;
        const mimeType =
            media.mimeType === undefined ? "unknown" : boundedMediaString(media.mimeType, 256);

        for (const dimension of [media.width, media.height]) {
            if (dimension !== undefined && !isSafeNonNegativeInteger(dimension)) {
                throw new MediaLimitError("The media dimensions are invalid.");
            }
        }

        for (const dimension of [options.width, options.height]) {
            if (
                dimension !== undefined &&
                (!isSafeNonNegativeInteger(dimension) || dimension <= 0 || dimension > 16_384)
            ) {
                throw new MediaLimitError("The media dimensions are invalid.");
            }
        }

        if (
            options.width !== undefined &&
            options.height !== undefined &&
            options.width * options.height > 16_777_216
        ) {
            throw new MediaLimitError("The media dimensions are invalid.");
        }

        if (
            options.resizeMethod !== undefined &&
            options.resizeMethod !== "crop" &&
            options.resizeMethod !== "scale"
        ) {
            throw new MediaLimitError("The media options are invalid.");
        }

        if (
            options.expectedKind !== undefined &&
            !["image", "video", "audio", "file"].includes(options.expectedKind)
        ) {
            throw new MediaLimitError("The media options are invalid.");
        }

        const tuple = {
            alias: boundedMediaString(options.cacheKey ?? media.mxcUrl, 4096),
            mxcUrl: boundedMediaString(media.mxcUrl, 4096),
            mode: encrypted ? "encrypted" : "plain",
            size: media.size ?? "unknown",
            mimeType,
            mediaWidth: media.width ?? "unknown",
            mediaHeight: media.height ?? "unknown",
            width: options.width ?? "full",
            height: options.height ?? "full",
            resizeMethod: options.resizeMethod ?? "scale",
            expectedKind: options.expectedKind ?? "unknown",
            encryptedDigest: digest,
        };

        if (
            (typeof tuple.width === "number" && !Number.isSafeInteger(tuple.width)) ||
            (typeof tuple.height === "number" && !Number.isSafeInteger(tuple.height))
        ) {
            throw new MediaLimitError("The media dimensions are invalid.");
        }

        return JSON.stringify(tuple);
    }

    private addMediaAlias(alias: string, key: string): void {
        const keys = this.mediaAliases.get(alias) ?? new Set<string>();

        keys.add(key);
        this.mediaAliases.set(alias, keys);
    }

    private removeMediaAlias(alias: string, key: string): void {
        const keys = this.mediaAliases.get(alias);

        if (!keys) {
            return;
        }

        keys.delete(key);

        if (keys.size === 0) {
            this.mediaAliases.delete(alias);
        }
    }

    async getMediaAsset(
        media: MatrixMediaRef,
        options: MediaRequestOptions = {},
    ): Promise<MediaAsset> {
        const client = this.requireClient();
        const generation = this.lifecycleGeneration;
        const expectedKind = options.expectedKind ?? "file";
        const maximumBytes = this.mediaReceiveLimit(expectedKind);

        assertDeclaredMediaLimits(
            expectedKind === "image" ? media : { size: media.size },
            maximumBytes,
        );
        const reservation = isSafeNonNegativeInteger(media.size) ? media.size : maximumBytes;
        const invalidationGeneration = this.mediaInvalidationGeneration;
        const lease = await this.mediaGate.acquire(reservation, options.signal);
        const controller = new AbortController();
        const unlinkGateAbort = this.linkGateAbort(lease, controller);

        try {
            this.assertMediaOperationActive(client, generation, lease);
            const key = await this.mediaCacheKey(media, options);

            this.assertMediaOperationActive(client, generation, lease);
            const alias = this.mediaCacheAlias(media, options.cacheKey);

            if (invalidationGeneration !== this.mediaInvalidationGeneration) {
                throw new DOMException("The media request was invalidated.", "AbortError");
            }

            const existing = this.mediaAssets.get(key);

            if (existing) {
                this.touchCacheEntry(this.mediaAssets, key, existing);
                const asset = await existing.promise;

                this.assertMediaOperationActive(client, generation, lease);
                existing.value = asset;

                if (invalidationGeneration !== this.mediaInvalidationGeneration) {
                    throw new DOMException("The media request was invalidated.", "AbortError");
                }

                return asset;
            }

            this.ensureMediaCacheSlot();
            const entry: MediaCacheEntry<MediaAsset> = {
                promise: Promise.resolve(null as unknown as MediaAsset),
                byteLength: 0,
                lastUsed: ++this.mediaCacheClock,
                settled: false,
                released: false,
                controller,
                alias,
            };

            entry.promise = this.loadMedia(
                media,
                options,
                controller.signal,
                lease.signal,
                client,
                generation,
                lease,
            );
            this.mediaAssets.set(key, entry);
            this.addMediaAlias(alias, key);

            try {
                const asset = await entry.promise;

                entry.value = asset;
                this.mediaAssetKeys.set(asset, key);
                this.assertMediaOperationActive(client, generation, lease);

                if (invalidationGeneration !== this.mediaInvalidationGeneration) {
                    throw new DOMException("The media request was invalidated.", "AbortError");
                }

                entry.settled = true;

                if (this.mediaAssets.get(key) === entry && !entry.released) {
                    entry.byteLength = asset.blob.size;
                    this.mediaCacheBytes += entry.byteLength;
                    this.evictMediaCache("media", key);
                }

                return asset;
            } catch (error) {
                if (this.mediaAssets.get(key) === entry) {
                    this.mediaAssets.delete(key);
                    this.removeMediaAlias(alias, key);
                }

                this.releaseMediaEntry(entry);

                throw error;
            }
        } finally {
            unlinkGateAbort();
            lease.release();
        }
    }

    invalidateMedia(media: MatrixMediaRef, cacheKey?: string): void {
        this.mediaInvalidationGeneration += 1;
        const alias = this.mediaCacheAlias(media, cacheKey);
        const keys = new Set(this.mediaAliases.get(alias) ?? []);

        for (const key of keys) {
            const entry = this.mediaAssets.get(key);

            if (entry) {
                this.mediaAssets.delete(key);
                this.removeMediaAlias(alias, key);
                this.releaseMediaEntry(entry);
            }
        }

        for (const [key, entry] of this.gifPosters) {
            if (entry.alias !== alias) {
                continue;
            }

            this.gifPosters.delete(key);
            this.releasePosterEntry(entry);
        }
    }

    async getGifPoster(media: MatrixMediaRef, cacheKey?: string): Promise<string | null> {
        const client = this.requireClient();
        const generation = this.lifecycleGeneration;
        const invalidationGeneration = this.mediaInvalidationGeneration;
        const alias = this.mediaCacheAlias(media, cacheKey);
        const controller = new AbortController();
        const asset = await this.getMediaAsset(media, {
            cacheKey,
            expectedKind: "image",
            signal: controller.signal,
        });

        this.assertMediaOperationActive(client, generation);

        if (invalidationGeneration !== this.mediaInvalidationGeneration) {
            throw new DOMException("The media request was invalidated.", "AbortError");
        }

        const mediaKey = this.mediaAssetKeys.get(asset);

        if (!mediaKey) {
            throw new MediaBusyError("The media cache entry is no longer available.");
        }

        const key = `${mediaKey}|poster`;
        const existing = this.gifPosters.get(key);

        if (existing) {
            this.touchCacheEntry(this.gifPosters, key, existing);
            const poster = await existing.promise;

            existing.value = poster;

            this.assertMediaOperationActive(client, generation);

            if (invalidationGeneration !== this.mediaInvalidationGeneration) {
                throw new DOMException("The media request was invalidated.", "AbortError");
            }

            return poster?.url ?? null;
        }

        this.ensureMediaCacheSlot();
        const entry: MediaCacheEntry<PosterAsset | null> = {
            promise: Promise.resolve(null),
            byteLength: 0,
            lastUsed: ++this.mediaCacheClock,
            settled: false,
            released: false,
            controller,
            alias,
        };

        entry.promise = this.createGifPoster(asset, client, generation, controller.signal);
        this.gifPosters.set(key, entry);

        try {
            const poster = await entry.promise;

            entry.value = poster;

            this.assertMediaOperationActive(client, generation);

            if (invalidationGeneration !== this.mediaInvalidationGeneration) {
                throw new DOMException("The media request was invalidated.", "AbortError");
            }

            entry.settled = true;

            if (this.gifPosters.get(key) === entry && !entry.released) {
                entry.byteLength = poster?.byteLength ?? 0;
                this.mediaCacheBytes += entry.byteLength;
                this.evictMediaCache("poster", key);
            }

            return poster?.url ?? null;
        } catch (error) {
            if (this.gifPosters.get(key) === entry) {
                this.gifPosters.delete(key);
            }

            this.releasePosterEntry(entry);

            throw error;
        }
    }

    private async createGifPoster(
        asset: MediaAsset,
        client?: MatrixClient,
        generation?: number,
        signal?: AbortSignal,
    ): Promise<PosterAsset | null> {
        if (typeof document === "undefined") {
            return null;
        }

        const posterClient = client ?? this.requireClient();
        const posterGeneration = generation ?? this.lifecycleGeneration;
        const deadlineController = new AbortController();
        const deadlineAt = Date.now() + MEDIA_IMAGE_DEADLINE_MS;
        const abort = () => deadlineController.abort(signal?.reason);
        const timeout = setTimeout(
            () => deadlineController.abort(new MediaTimeoutError("The image preview timed out.")),
            Math.max(0, deadlineAt - Date.now()),
        );

        signal?.addEventListener("abort", abort, { once: true });
        let decodeLease: MediaOperationLease | null = null;
        let unlinkGateAbort: () => void = () => undefined;

        try {
            this.assertMediaOperationActive(posterClient, posterGeneration);
            const sourceBlob = asset.blob;
            const decodeController = deadlineController;

            decodeLease = await this.mediaGate.acquire(
                MAX_IMAGE_DECODED_BYTES,
                decodeController.signal,
            );
            unlinkGateAbort = this.linkGateAbort(decodeLease, decodeController);
            this.assertMediaOperationActive(posterClient, posterGeneration, decodeLease);

            let source: CanvasImageSource | null = null;
            let bitmap: ImageBitmap | null = null;
            let image: HTMLImageElement | null = null;
            let sourceUrl: string | null = null;
            let width = 0;
            let height = 0;

            try {
                this.assertMediaDeadline(deadlineAt);

                if (typeof globalThis.createImageBitmap === "function") {
                    bitmap = await createImageBitmap(sourceBlob);
                    source = bitmap;
                    width = bitmap.width;
                    height = bitmap.height;
                } else {
                    sourceUrl = URL.createObjectURL(sourceBlob);
                    image = new Image();
                    image.src = sourceUrl;
                    await image.decode();
                    source = image;
                    width = image.naturalWidth;
                    height = image.naturalHeight;
                }

                this.assertMediaDeadline(deadlineAt);
                this.assertMediaOperationActive(posterClient, posterGeneration, decodeLease);
                assertDeclaredMediaLimits({ width, height });
                this.assertMediaDeadline(deadlineAt);
                const scale = Math.min(1, 1000 / Math.max(width, height));
                const canvas = document.createElement("canvas");

                canvas.width = Math.max(1, Math.round(width * scale));
                canvas.height = Math.max(1, Math.round(height * scale));
                const context = canvas.getContext("2d");

                if (!context || !source) {
                    return null;
                }

                context.drawImage(source, 0, 0, canvas.width, canvas.height);
                this.assertMediaDeadline(deadlineAt);
                const blob = await new Promise<Blob | null>((resolve) =>
                    canvas.toBlob(resolve, "image/png"),
                );

                this.assertMediaDeadline(deadlineAt);
                this.assertMediaOperationActive(posterClient, posterGeneration, decodeLease);

                if (!blob) {
                    return null;
                }

                const url = URL.createObjectURL(blob);

                try {
                    this.assertMediaDeadline(deadlineAt);
                    this.assertMediaOperationActive(posterClient, posterGeneration, decodeLease);

                    return { url, byteLength: blob.size };
                } catch (error) {
                    URL.revokeObjectURL(url);

                    throw error;
                }
            } catch (error) {
                if (
                    decodeController.signal.aborted ||
                    this.stopped ||
                    this.client !== posterClient ||
                    this.lifecycleGeneration !== posterGeneration ||
                    error instanceof MediaLimitError ||
                    error instanceof MediaBusyError ||
                    error instanceof MediaTimeoutError
                ) {
                    if (
                        !decodeController.signal.aborted &&
                        (this.stopped ||
                            this.client !== posterClient ||
                            this.lifecycleGeneration !== posterGeneration)
                    ) {
                        throw new DOMException("The image preview was cancelled.", "AbortError");
                    }

                    throw error;
                }

                return null;
            } finally {
                bitmap?.close();

                if (sourceUrl) {
                    URL.revokeObjectURL(sourceUrl);
                }
            }
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener("abort", abort);
            unlinkGateAbort();
            decodeLease?.release();
        }
    }

    private async loadMedia(
        media: MatrixMediaRef,
        options: MediaRequestOptions = {},
        signal?: AbortSignal,
        gateSignal?: AbortSignal,
        operationClient?: MatrixClient,
        operationGeneration = this.lifecycleGeneration,
        operationLease?: MediaOperationLease,
    ): Promise<MediaAsset> {
        const expectedKind = options.expectedKind ?? "file";
        const maximumBytes = this.mediaReceiveLimit(expectedKind);

        assertDeclaredMediaLimits(
            expectedKind === "image" ? media : { size: media.size },
            maximumBytes,
        );
        const deadlineController = new AbortController();
        const onAbort = () => deadlineController.abort(signal?.reason ?? gateSignal?.reason);
        const onGateAbort = () => deadlineController.abort(gateSignal?.reason);

        signal?.addEventListener("abort", onAbort, { once: true });
        gateSignal?.addEventListener("abort", onGateAbort, { once: true });
        const totalTimeoutMs =
            expectedKind === "image" ? MEDIA_IMAGE_DEADLINE_MS : MEDIA_NONIMAGE_DEADLINE_MS;
        const deadlineAt = Date.now() + totalTimeoutMs;
        const deadline = setTimeout(() => {
            deadlineController.abort(new MediaTimeoutError());
        }, totalTimeoutMs);
        const client = operationClient ?? this.requireClient();
        const useThumbnail = !media.encryptedFile && options.width && options.height;

        try {
            const authenticatedUrl = client.mxcUrlToHttp(
                media.mxcUrl,
                useThumbnail ? options.width : undefined,
                useThumbnail ? options.height : undefined,
                useThumbnail ? (options.resizeMethod ?? "scale") : undefined,
                false,
                true,
                true,
            );

            if (!authenticatedUrl) {
                throw new Error("The homeserver returned an invalid media address.");
            }

            const token = client.getAccessToken();
            let response = await fetch(authenticatedUrl, {
                headers: mediaAuthorizationHeaders(
                    authenticatedUrl,
                    client.getHomeserverUrl(),
                    token,
                ),
                cache: "no-store",
                signal: deadlineController.signal,
            });

            this.assertMediaOperationActive(client, operationGeneration, operationLease);

            if (shouldTryLegacyMedia(response.status)) {
                const legacyUrl = client.mxcUrlToHttp(
                    media.mxcUrl,
                    useThumbnail ? options.width : undefined,
                    useThumbnail ? options.height : undefined,
                    useThumbnail ? (options.resizeMethod ?? "scale") : undefined,
                    false,
                    false,
                    false,
                );

                if (legacyUrl && legacyUrl !== authenticatedUrl) {
                    await response.body?.cancel().catch(() => undefined);
                    this.assertMediaOperationActive(client, operationGeneration, operationLease);
                    response = await fetch(legacyUrl, {
                        headers: mediaAuthorizationHeaders(
                            legacyUrl,
                            client.getHomeserverUrl(),
                            token,
                        ),
                        cache: "no-store",
                        signal: deadlineController.signal,
                    });
                    this.assertMediaOperationActive(client, operationGeneration, operationLease);
                }
            }

            if (!response.ok) {
                throw new Error(`Media download failed (${response.status}).`);
            }

            let bytes = await readBoundedResponse(response, maximumBytes, {
                signal: deadlineController.signal,
                deadlineAt,
                idleTimeoutMs: MEDIA_IDLE_TIMEOUT_MS,
            });

            this.assertMediaOperationActive(client, operationGeneration, operationLease);
            this.assertMediaDeadline(deadlineAt);

            if (media.encryptedFile) {
                bytes = await decryptAttachment(
                    bytes,
                    media.encryptedFile as unknown as IEncryptedFile,
                );
                this.assertMediaOperationActive(client, operationGeneration, operationLease);
            }

            this.assertMediaDeadline(deadlineAt);
            deadlineController.signal.throwIfAborted();
            assertMediaByteLength(bytes.byteLength, maximumBytes);
            const byteView = new Uint8Array(bytes);
            const imageSafety =
                options.expectedKind === "image" ? assertSafeImageBytes(byteView) : null;

            this.assertMediaDeadline(deadlineAt);
            const mimeType = boundedMediaString(
                imageSafety?.mimeType ??
                    media.mimeType ??
                    response.headers.get("content-type")?.split(";")[0] ??
                    "application/octet-stream",
                256,
            );
            const blob = new Blob([bytes], { type: mimeType });

            this.assertMediaDeadline(deadlineAt);
            const url = URL.createObjectURL(blob);

            try {
                this.assertMediaDeadline(deadlineAt);

                return {
                    url,
                    blob,
                    mimeType,
                    animated: imageSafety?.animated ?? false,
                };
            } catch (error) {
                URL.revokeObjectURL(url);

                throw error;
            }
        } catch (error) {
            if (
                deadlineController.signal.aborted &&
                deadlineController.signal.reason instanceof MediaTimeoutError
            ) {
                throw deadlineController.signal.reason;
            }

            throw error;
        } finally {
            clearTimeout(deadline);
            signal?.removeEventListener("abort", onAbort);
            gateSignal?.removeEventListener("abort", onGateAbort);
        }
    }

    private touchCacheEntry<T>(
        cache: Map<string, MediaCacheEntry<T>>,
        key: string,
        entry: MediaCacheEntry<T>,
    ): void {
        entry.lastUsed = ++this.mediaCacheClock;
        cache.delete(key);
        cache.set(key, entry);
    }

    private ensureMediaCacheSlot(): void {
        while (this.mediaAssets.size + this.gifPosters.size >= MAX_MEDIA_CACHE_ENTRIES) {
            if (!this.evictOldestSettledEntry()) {
                throw new MediaLimitError(
                    "Too many attachments are already being prepared for preview.",
                );
            }
        }
    }

    private evictMediaCache(protectedKind: "media" | "poster", protectedKey: string): void {
        while (
            this.mediaCacheBytes > MAX_MEDIA_CACHE_BYTES ||
            this.mediaAssets.size + this.gifPosters.size > MAX_MEDIA_CACHE_ENTRIES
        ) {
            if (!this.evictOldestSettledEntry(protectedKind, protectedKey)) {
                break;
            }
        }
    }

    private evictOldestSettledEntry(
        protectedKind?: "media" | "poster",
        protectedKey?: string,
    ): boolean {
        let candidate: { kind: "media" | "poster"; key: string; lastUsed: number } | null = null;

        for (const [key, entry] of this.mediaAssets) {
            if (!entry.settled || entry.released) {
                continue;
            }

            if (protectedKind === "media" && protectedKey === key) {
                continue;
            }

            if (!candidate || entry.lastUsed < candidate.lastUsed) {
                candidate = { kind: "media", key, lastUsed: entry.lastUsed };
            }
        }

        for (const [key, entry] of this.gifPosters) {
            if (!entry.settled || entry.released) {
                continue;
            }

            if (protectedKind === "poster" && protectedKey === key) {
                continue;
            }

            if (!candidate || entry.lastUsed < candidate.lastUsed) {
                candidate = { kind: "poster", key, lastUsed: entry.lastUsed };
            }
        }

        if (!candidate) {
            return false;
        }

        if (candidate.kind === "media") {
            const entry = this.mediaAssets.get(candidate.key);

            if (!entry) {
                return false;
            }

            this.mediaAssets.delete(candidate.key);

            if (entry.alias) {
                this.removeMediaAlias(entry.alias, candidate.key);
            }

            this.releaseMediaEntry(entry);
        } else {
            const entry = this.gifPosters.get(candidate.key);

            if (!entry) {
                return false;
            }

            this.gifPosters.delete(candidate.key);
            this.releasePosterEntry(entry);
        }

        return true;
    }

    private releaseMediaEntry(entry: MediaCacheEntry<MediaAsset>): void {
        if (entry.released) {
            return;
        }

        entry.released = true;
        entry.controller?.abort();

        if (entry.settled) {
            this.mediaCacheBytes = Math.max(0, this.mediaCacheBytes - entry.byteLength);
        }

        if (entry.value) {
            URL.revokeObjectURL(entry.value.url);
        } else {
            void entry.promise
                .then((asset) => URL.revokeObjectURL(asset.url))
                .catch(() => undefined);
        }
    }

    private releasePosterEntry(entry: MediaCacheEntry<PosterAsset | null>): void {
        if (entry.released) {
            return;
        }

        entry.released = true;
        entry.controller?.abort();

        if (entry.settled) {
            this.mediaCacheBytes = Math.max(0, this.mediaCacheBytes - entry.byteLength);
        }

        if (entry.value) {
            URL.revokeObjectURL(entry.value.url);
        } else {
            void entry.promise
                .then((poster) => {
                    if (poster) {
                        URL.revokeObjectURL(poster.url);
                    }
                })
                .catch(() => undefined);
        }
    }

    async toggleReaction(eventId: string, key: string): Promise<void> {
        const client = this.requireClient();
        const roomId = this.snapshot.activeRoomId;

        if (!roomId) {
            return;
        }

        const ownReactionEventId = findOwnReactionEventId(this.snapshot.timeline, eventId, key);

        if (ownReactionEventId) {
            await client.redactEvent(roomId, ownReactionEventId, undefined, {
                reason: "Reaction removed in Sub-Etha",
            });

            return;
        }

        await client.sendEvent(roomId, EventType.Reaction, {
            "m.relates_to": { rel_type: RelationType.Annotation, event_id: eventId, key },
        });
    }

    async redact(eventId: string): Promise<void> {
        const client = this.requireClient();

        if (!this.snapshot.activeRoomId) {
            return;
        }

        await client.redactEvent(this.snapshot.activeRoomId, eventId, undefined, {
            reason: "Removed in Sub-Etha",
        });
    }

    async retry(item: TimelineItem): Promise<void> {
        const client = this.requireClient();
        const room = this.snapshot.activeRoomId ? client.getRoom(this.snapshot.activeRoomId) : null;

        if (room) {
            await client.resendEvent(item.event, room);
        }
    }

    async markRoomRead(roomId: string): Promise<void> {
        const client = this.requireClient();
        const room = client.getRoom(roomId);
        const event = room
            ?.getLiveTimeline()
            .getEvents()
            .toReversed()
            .find((candidate) => candidate.getId());
        const eventId = event?.getId();

        if (!room || !event || !eventId || this.lastReadEventIds.get(roomId) === eventId) {
            return;
        }

        this.readMarkerTargets.set(roomId, { event, eventId });
        const existing = this.readMarkerTasks.get(roomId);

        if (existing) {
            return existing;
        }

        const task = this.flushReadMarkers(roomId);

        this.readMarkerTasks.set(roomId, task);

        try {
            await task;
        } finally {
            if (this.readMarkerTasks.get(roomId) === task) {
                this.readMarkerTasks.delete(roomId);
            }
        }
    }

    private async flushReadMarkers(roomId: string): Promise<void> {
        while (!this.stopped) {
            const target = this.readMarkerTargets.get(roomId);

            if (!target) {
                return;
            }

            if (this.lastReadEventIds.get(roomId) === target.eventId) {
                this.readMarkerTargets.delete(roomId);
                continue;
            }

            try {
                await this.requireClient().setRoomReadMarkers(roomId, target.eventId, target.event);
            } catch {
                return;
            }

            if (this.stopped) {
                return;
            }

            this.lastReadEventIds.set(roomId, target.eventId);

            if (this.readMarkerTargets.get(roomId)?.eventId === target.eventId) {
                this.readMarkerTargets.delete(roomId);
            }

            const room = this.client?.getRoom(roomId);

            room?.setUnreadNotificationCount(NotificationCountType.Total, 0);
            room?.setUnreadNotificationCount(NotificationCountType.Highlight, 0);
            this.refreshDerivedState(roomId === this.snapshot.activeRoomId);
        }
    }

    async setTyping(typing: boolean): Promise<void> {
        const client = this.requireClient();

        if (!this.snapshot.activeRoomId) {
            return;
        }

        try {
            await client.sendTyping(this.snapshot.activeRoomId, typing, 5_000);
        } catch {
            /* ephemeral */
        }
    }

    async joinRoom(roomIdOrAlias: string): Promise<void> {
        const room = await this.requireClient().joinRoom(roomIdOrAlias.trim());

        this.refreshDerivedState(true);
        this.selectRoom(room.roomId);
    }

    async createRoom(options: {
        name?: string;
        invite?: string;
        direct?: boolean;
        encrypted?: boolean;
    }): Promise<string> {
        const invite = options.invite?.trim();
        const response = await this.requireClient().createRoom({
            name: options.name?.trim() || undefined,
            invite: invite ? [invite] : undefined,
            is_direct: Boolean(options.direct),
            preset: "trusted_private_chat" as never,
            initial_state:
                options.encrypted === false
                    ? undefined
                    : [
                          {
                              type: "m.room.encryption",
                              state_key: "",
                              content: { algorithm: "m.megolm.v1.aes-sha2" },
                          },
                      ],
        });

        this.refreshDerivedState(true);
        this.selectRoom(response.room_id);

        return response.room_id;
    }

    async invite(userId: string): Promise<void> {
        if (!this.snapshot.activeRoomId) {
            return;
        }

        await this.requireClient().invite(this.snapshot.activeRoomId, userId.trim());
    }

    async leaveActiveRoom(): Promise<void> {
        if (!this.snapshot.activeRoomId) {
            return;
        }

        await this.requireClient().leave(this.snapshot.activeRoomId);
        this.selectRoom(null);
        this.refreshDerivedState(true);
    }

    async setRoomMuted(muted: boolean): Promise<void> {
        if (!this.snapshot.activeRoomId) {
            return;
        }

        await this.requireClient().setRoomMutePushRule("global", this.snapshot.activeRoomId, muted);
        this.refreshDerivedState();
    }

    async searchCurrentRoom(term: string): Promise<TimelineItem[]> {
        const client = this.requireClient();
        const roomId = this.snapshot.activeRoomId;

        if (!roomId || !term.trim()) {
            return [];
        }

        const response = await client.searchRoomEvents({
            term: term.trim(),
            filter: { rooms: [roomId] },
        });
        const room = client.getRoom(roomId);

        if (!room) {
            return [];
        }

        const events = response.results
            .map((result) => result.context.getEvent())
            .filter(Boolean) as MatrixEvent[];
        const eventIds = new Set(events.map((event) => event.getId()));

        return normalizeTimeline(room, client).filter(
            (item) => eventIds.has(item.id) || item.body.toLowerCase().includes(term.toLowerCase()),
        );
    }

    async updateProfile(displayName: string, avatar?: File): Promise<void> {
        const client = this.requireClient();
        const generation = this.lifecycleGeneration;
        const abortController = avatar ? new AbortController() : null;
        let lease: MediaOperationLease | null = null;
        let unlinkGateAbort: () => void = () => undefined;

        if (avatar && abortController) {
            assertMediaByteLength(avatar.size, MAX_AVATAR_BYTES);
            this.activeUploadControllers.add(abortController);
        }

        try {
            let prepared: PreparedImageFile | null = null;

            if (avatar && abortController) {
                lease = await this.mediaGate.acquire(avatar.size, abortController.signal);
                unlinkGateAbort = this.linkGateAbort(lease, abortController);
                this.assertMediaOperationActive(client, generation, lease);
                const limit = await this.effectiveUploadLimit(
                    client,
                    generation,
                    MAX_AVATAR_BYTES,
                    lease.signal,
                );

                this.assertMediaOperationActive(client, generation, lease);
                prepared = await this.prepareImageFile(avatar, limit);
                this.assertMediaOperationActive(client, generation, lease);
            }

            this.assertUploadActive(client, generation);

            if (displayName.trim()) {
                await client.setDisplayName(boundedMediaString(displayName.trim(), 255));
                this.assertUploadActive(client, generation);
            }

            if (avatar && prepared && lease && abortController) {
                const upload = await this.uploadMedia(
                    client,
                    generation,
                    lease,
                    abortController,
                    prepared.file,
                    {
                        name: prepared.file.name,
                        type: prepared.file.type,
                    },
                );

                this.assertMediaOperationActive(client, generation, lease);
                await client.setAvatarUrl(upload.content_uri);
                this.assertMediaOperationActive(client, generation, lease);
            } else {
                this.assertUploadActive(client, generation);
            }
        } finally {
            unlinkGateAbort();

            if (abortController) {
                this.activeUploadControllers.delete(abortController);
            }

            lease?.release();
        }

        this.assertUploadActive(client, generation);
        this.refreshDerivedState(true);
        await this.refreshOwnProfile();
    }

    async getDevices(): Promise<DeviceSummary[]> {
        const client = this.requireClient();
        const session = this.requireLease().session;
        const cryptoApi = client.getCrypto();
        const response = await client.getDevices();

        return Promise.all(
            response.devices.map(async (device) => {
                const trust = await cryptoApi
                    ?.getDeviceVerificationStatus(session.userId, device.device_id)
                    .catch(() => null);

                return {
                    deviceId: device.device_id,
                    displayName: device.display_name || "Unnamed device",
                    lastSeenTs: device.last_seen_ts,
                    lastSeenIp: device.last_seen_ip,
                    current: device.device_id === session.deviceId,
                    verified: trust?.isVerified() ?? false,
                };
            }),
        );
    }

    async getCryptoStatus() {
        const cryptoApi = this.requireClient().getCrypto();

        if (!cryptoApi) {
            return { secretStorageReady: false, crossSigningReady: false, backupVersion: null };
        }

        const [secretStatus, crossSigning, backupVersion] = await Promise.all([
            cryptoApi.getSecretStorageStatus(),
            cryptoApi.getCrossSigningStatus(),
            cryptoApi.getActiveSessionBackupVersion(),
        ]);

        return {
            secretStorageReady: secretStatus.ready,
            crossSigningReady:
                crossSigning.publicKeysOnDevice &&
                (crossSigning.privateKeysInSecretStorage ||
                    Object.values(crossSigning.privateKeysCachedLocally).every(Boolean)),
            backupVersion,
        };
    }

    async setupRecovery(passphrase?: string): Promise<string> {
        const client = this.requireClient();
        const generation = this.lifecycleGeneration;
        const cryptoApi = client.getCrypto();

        if (!cryptoApi) {
            throw new Error("Encryption is not available on this device.");
        }

        const generated = await cryptoApi.createRecoveryKeyFromPassphrase(
            passphrase?.trim() || undefined,
        );
        const material = { generated };

        this.transientRecoverySetups.add(material);

        try {
            this.assertClientLifecycleActive(client, generation);
            await cryptoApi.bootstrapSecretStorage({
                createSecretStorageKey: async () => {
                    this.assertClientLifecycleActive(client, generation);

                    return generated;
                },
                setupNewKeyBackup: true,
            });
            this.assertClientLifecycleActive(client, generation);

            const encodedPrivateKey = generated.encodedPrivateKey;

            this.clearTransientRecoverySetup(material);

            return (
                encodedPrivateKey ?? "Recovery storage was configured with the supplied passphrase."
            );
        } finally {
            this.clearTransientRecoverySetup(material);
        }
    }

    async unlockRecovery(secret: string): Promise<void> {
        const client = this.requireClient();
        const generation = this.lifecycleGeneration;
        const cryptoApi = client.getCrypto();

        if (!cryptoApi) {
            throw new Error("Encryption is not available on this device.");
        }

        const status = await cryptoApi.getSecretStorageStatus();

        this.assertClientLifecycleActive(client, generation);

        if (!status.defaultKeyId) {
            throw new Error("This account does not have a recovery key configured.");
        }

        const keyInfo = status.secretStorageKeyValidityMap;
        const keyTuple = await client.secretStorage.getKey(status.defaultKeyId);

        this.assertClientLifecycleActive(client, generation);
        const keyDescription = keyTuple?.[1];
        let key: Uint8Array<ArrayBuffer> | null = null;

        try {
            if (keyDescription?.passphrase) {
                key = await deriveRecoveryKeyFromPassphrase(
                    secret,
                    keyDescription.passphrase.salt,
                    keyDescription.passphrase.iterations,
                    keyDescription.passphrase.bits,
                );
            } else {
                key = decodeRecoveryKey(secret);
            }

            this.assertClientLifecycleActive(client, generation);
            void keyInfo;
            this.cacheSecretStorageKey(client, generation, status.defaultKeyId, key);
            key.fill(0);
            key = null;
            await cryptoApi.loadSessionBackupPrivateKeyFromSecretStorage();
            this.assertClientLifecycleActive(client, generation);
            await cryptoApi.checkKeyBackupAndEnable();
            this.assertClientLifecycleActive(client, generation);
        } finally {
            key?.fill(0);
        }
    }

    private async cancelLateVerificationRequest(request: VerificationRequest): Promise<void> {
        try {
            if (request.pending) {
                await request.cancel();
            }
        } catch {
            /* the local verification context was never attached */
        }
    }

    async startDeviceVerification(deviceId?: string): Promise<void> {
        const client = this.requireClient();
        const generation = this.lifecycleGeneration;
        const session = this.requireLease().session;
        const cryptoApi = client.getCrypto();

        if (!cryptoApi) {
            throw new Error("Encryption is not available on this device.");
        }

        if (this.activeVerification?.request.pending) {
            throw new Error("A device verification is already in progress.");
        }

        const request = deviceId
            ? await cryptoApi.requestDeviceVerification(session.userId, deviceId)
            : await cryptoApi.requestOwnUserVerification();

        if (!this.isClientLifecycleActive(client, generation)) {
            await this.cancelLateVerificationRequest(request);
            this.assertClientLifecycleActive(client, generation);
        }

        const direction = request.initiatedByMe ? "outgoing" : "incoming";
        const context = this.bindVerification(request, direction);

        this.emit({
            verification: this.verificationState(
                context,
                direction === "incoming" ? "incoming" : "waiting",
                {
                    message:
                        direction === "incoming"
                            ? "Another Sub-Etha receiver wants to verify this device."
                            : "Open Sub-Etha on your other device and accept the verification request.",
                },
            ),
        });
        this.handleVerificationChange(request);
    }

    async acceptDeviceVerification(): Promise<void> {
        const context = this.activeVerification;

        if (!context || context.direction !== "incoming") {
            throw new Error("There is no incoming verification request.");
        }

        this.emit({
            verification: this.verificationState(context, "waiting", {
                message:
                    "Request accepted. Waiting for your other Sub-Etha receiver to begin the comparison.",
            }),
        });
        await context.request.accept();
        this.handleVerificationChange(context.request);
    }

    async confirmDeviceVerification(matches: boolean): Promise<void> {
        const context = this.activeVerification;
        const callbacks = context?.sasCallbacks;

        if (!context || !callbacks) {
            throw new Error("The emoji comparison is not ready yet.");
        }

        context.sasCallbacks = null;

        if (!matches) {
            callbacks.mismatch();
            this.finishVerification(
                "cancelled",
                "The emoji did not match, so verification was safely cancelled.",
            );

            return;
        }

        this.emit({
            verification: this.verificationState(context, "waiting", {
                message: "Match confirmed here. Waiting for your other device to confirm as well.",
            }),
        });
        await callbacks.confirm();
    }

    async cancelDeviceVerification(): Promise<void> {
        const context = this.activeVerification;

        if (!context) {
            this.emit({ verification: null });

            return;
        }

        try {
            if (context.sasCallbacks) {
                context.sasCallbacks.cancel();
            } else {
                await context.request.cancel();
            }
        } finally {
            if (this.activeVerification === context) {
                this.finishVerification("cancelled", "Verification cancelled.");
            }
        }
    }

    dismissDeviceVerification(): void {
        if (!this.activeVerification) {
            this.emit({ verification: null });
        }
    }

    getClient(): MatrixClient {
        return this.requireClient();
    }

    async removePusher(pushKey: string): Promise<void> {
        const request: IPusherRequest = {
            app_display_name: "Sub-Etha",
            app_id: "chat.subetha.pwa",
            device_display_name: "Sub-Etha PWA",
            kind: null as never,
            lang: navigator.language || "en",
            pushkey: pushKey,
            data: {},
        };

        await this.requireClient().setPusher(request);
    }

    logout(): Promise<MatrixLogoutResult> {
        if (this.logoutTask) {
            return this.logoutTask;
        }

        let lease: SessionLease;

        try {
            lease = this.requireLease();
        } catch (error) {
            return Promise.reject(error);
        }

        const pendingStart = this.startTask;
        const pendingRefresh = this.refreshTask;

        this.shutdownMode = "logout";
        this.stopped = true;
        this.lifecycleGeneration += 1;
        this.scrubSnapshot(null);
        this.logoutTask = this.performLogout(lease, pendingStart, pendingRefresh);

        return this.logoutTask;
    }

    private async performLogout(
        lease: SessionLease,
        pendingStart: Promise<void> | null,
        pendingRefresh: Promise<unknown> | null,
    ): Promise<MatrixLogoutResult> {
        const cleanupErrors: unknown[] = [];
        let cleanup: SessionCleanupDescriptor;
        let finalSession: Readonly<PersistedMatrixSession>;

        try {
            // Local logout intent is the security boundary: close the current runtime and
            // durably replace its authenticated vault record before waiting on any network
            // work. SessionLease serializes this behind an already-committing reseal and then
            // disposes its key, so a delayed refresh can never recreate the locked record.
            this.closeRuntime();
            const deletion = await this.deleteCurrentSession(lease);

            cleanup = deletion.cleanup;
            finalSession = deletion.session;
        } catch (error) {
            await Promise.allSettled(
                [pendingStart, pendingRefresh].filter(
                    (operation): operation is Promise<unknown> => operation !== null,
                ),
            );
            this.closeRuntime();
            this.disposeLeaseAndReleaseLock();

            throw error;
        }

        let remoteSessionEnded = false;

        try {
            const remoteLogout = this.endRemoteSessionWithinDeadline(finalSession);
            const [, refreshSettlement] = await Promise.allSettled([
                pendingStart ?? Promise.resolve(),
                pendingRefresh ?? Promise.resolve(),
            ]);

            // Startup may have published a partial runtime before observing the generation
            // fence. Close it again before removing the exact Rust databases.
            this.closeRuntime();
            const finalSessionRevocation = await remoteLogout;
            const refreshSessionAccountedFor =
                refreshSettlement.status === "fulfilled" ||
                refreshSettlement.reason instanceof CommittedRefreshDuringShutdownError ||
                (refreshSettlement.reason instanceof DiscardedRefreshSessionError &&
                    refreshSettlement.reason.revocationConfirmed);

            remoteSessionEnded =
                finalSessionRevocation.confirmed &&
                refreshSessionAccountedFor &&
                !this.refreshSessionEndUncertain;
            await this.cleanupCurrentSessionDatabases(cleanup);
            await this.completeCurrentSessionCleanup(cleanup);
        } catch (error) {
            cleanupErrors.push(error);
        } finally {
            this.closeRuntime();
            this.disposeLeaseAndReleaseLock();
        }

        if (cleanupErrors.length === 1) {
            throw cleanupErrors[0];
        }

        if (cleanupErrors.length > 1) {
            throw new AggregateError(
                cleanupErrors,
                "The local Matrix session could not be fully removed.",
            );
        }

        return { remoteSessionEnded };
    }

    private endRemoteSessionWithinDeadline(
        session: Readonly<PersistedMatrixSession>,
    ): Promise<PendingMatrixSessionRevocationResult> {
        return boundedMatrixSessionRevocation(
            () => this.endRemoteSession(session),
            this.remoteLogoutTimeoutMs,
        );
    }

    private async endRemoteSession(session: Readonly<PersistedMatrixSession>): Promise<boolean> {
        return performMatrixSessionRevocation(session);
    }

    private deleteCurrentSession(lease: SessionLease): Promise<SessionDeletionResult> {
        return deleteSessionRecord(lease);
    }

    private cleanupCurrentSessionDatabases(cleanup: SessionCleanupDescriptor): Promise<void> {
        if (cleanup.scope === "exact" && this.releaseVaultLock) {
            return cleanupExactSessionDatabasesWhileHoldingVaultLock(cleanup);
        }

        return cleanupSessionDatabases(cleanup);
    }

    private completeCurrentSessionCleanup(cleanup: SessionCleanupDescriptor): Promise<void> {
        return completeLocalSessionCleanup(cleanup);
    }

    stop(): void {
        this.stopWithError(null);
    }

    shutdownForPageHide(): MatrixPageHideShutdownResult {
        this.pageHideRefreshInFlight ||= this.refreshTask !== null;
        const result = { refreshInFlight: this.pageHideRefreshInFlight };

        if (this.shutdownMode === "pagehide") {
            return result;
        }

        const pendingOperations: Promise<unknown>[] = [];

        if (this.startTask) {
            pendingOperations.push(this.startTask);
        }

        if (this.refreshTask) {
            pendingOperations.push(this.refreshTask);
        }

        if (this.logoutTask) {
            pendingOperations.push(this.logoutTask);
        }

        this.shutdownMode = "pagehide";
        this.stopped = true;
        this.lifecycleGeneration += 1;
        this.scrubSnapshot(null);
        this.closeRuntime();
        this.disposeLeaseOnly();

        if (pendingOperations.length === 0) {
            this.releaseOwnershipLocks();

            return result;
        }

        const releaseTask = Promise.allSettled(pendingOperations).then(() => {
            this.closeRuntime();
            this.releaseOwnershipLocks();
        });
        const tracked = releaseTask.finally(() => {
            if (this.pageHideReleaseTask === tracked) {
                this.pageHideReleaseTask = null;
            }
        });

        this.pageHideReleaseTask = tracked;
        void tracked.catch(() => undefined);

        return result;
    }

    private stopWithError(error: string | null): void {
        if (this.shutdownMode === "pagehide") {
            this.scrubSnapshot(error);

            return;
        }

        if (this.shutdownMode === "logout") {
            this.scrubSnapshot(error);

            return;
        }

        this.shutdownMode = "stop";
        this.stopped = true;
        this.lifecycleGeneration += 1;
        this.scrubSnapshot(error);
        const pendingStart = this.startTask;
        const pendingRefresh = this.refreshTask;

        this.closeRuntime();

        if (this.pendingStopReleaseTask) {
            return;
        }

        const pendingOperations: Promise<unknown>[] = [];

        if (pendingStart) {
            pendingOperations.push(pendingStart);
        }

        if (pendingRefresh) {
            pendingOperations.push(pendingRefresh);
        }

        if (pendingOperations.length > 0) {
            const refreshSettlement = pendingRefresh
                ? pendingRefresh.then(
                      () => ({ status: "fulfilled" as const }),
                      (reason: unknown) => ({ status: "rejected" as const, reason }),
                  )
                : null;
            const releaseTask = Promise.allSettled(pendingOperations).then(async () => {
                const settlement = await refreshSettlement;

                if (
                    settlement?.status === "rejected" &&
                    (settlement.reason instanceof MatrixSessionRevocationUnconfirmedError ||
                        (settlement.reason instanceof DiscardedRefreshSessionError &&
                            !settlement.reason.revocationConfirmed))
                ) {
                    this.reportRevocationUncertainty(settlement.reason);
                } else if (this.refreshSessionEndUncertain) {
                    this.reportRevocationUncertainty(new MatrixRefreshTimeoutError());
                }

                if (this.shutdownMode === "stop") {
                    this.closeRuntime();
                    this.disposeLeaseAndReleaseLock();
                }
            });
            const tracked = releaseTask.finally(() => {
                if (this.pendingStopReleaseTask === tracked) {
                    this.pendingStopReleaseTask = null;
                }
            });

            this.pendingStopReleaseTask = tracked;
            void tracked.catch(() => undefined);

            return;
        }

        this.disposeLeaseAndReleaseLock();
    }

    private scrubSnapshot(error: string | null): void {
        this.emit(
            {
                connection: "idle",
                rooms: [],
                activeRoomId: null,
                timeline: [],
                timelineStartIndex: INITIAL_TIMELINE_ITEM_INDEX,
                typingNames: [],
                loadingHistory: false,
                hasMoreHistory: false,
                error,
                userId: "",
                displayName: "",
                avatarMxcUrl: null,
                deviceId: "",
                verification: null,
            },
            true,
        );
        this.listeners.clear();
    }

    private closeRuntime(): void {
        this.clearTransientRecoverySetups();
        this.secretStorageKey?.[1].fill(0);
        this.secretStorageKey = null;
        this.clearRustCryptoStorageKey();

        for (const controller of this.activeUploadControllers) {
            controller.abort();
        }

        this.activeUploadControllers.clear();
        this.mediaGate.close(
            new DOMException("The Matrix media service was stopped.", "AbortError"),
        );
        this.mediaConfigState = null;
        this.mediaConfigTask = null;
        this.mediaConfigTaskClient = null;
        this.mediaConfigTaskGeneration = -1;
        this.releaseClientListeners();
        this.client?.stopClient();

        if (typeof window !== "undefined") {
            window.removeEventListener("storage", this.handleTakeoverRequest);
        }

        void this.store?.deleteAllData();
        this.releaseMediaAssets();
        this.releaseVerificationContext(true);
        this.client = null;
        this.store = null;
        this.started = false;
        this.paginationRequestId += 1;
        this.paginatingRoomId = null;
    }

    private clearRustCryptoStorageKey(
        expected: Uint8Array<ArrayBuffer> | null = this.rustCryptoStorageKey,
    ): void {
        if (!expected) {
            return;
        }

        try {
            expected.fill(0);
        } catch {
            /* a consumer may already have detached the transient buffer */
        }

        if (this.rustCryptoStorageKey === expected) {
            this.rustCryptoStorageKey = null;
        }
    }

    private disposeLeaseAndReleaseLock(): void {
        const lease = this.lease;

        this.lease = null;

        try {
            lease?.dispose();
        } finally {
            this.releaseOwnershipLocks();
        }
    }

    private disposeLeaseOnly(): void {
        const lease = this.lease;

        this.lease = null;
        lease?.dispose();
    }

    private releaseOwnershipLocks(): void {
        const releaseLock = this.releaseLock;
        const releaseVaultLock = this.releaseVaultLock;

        this.releaseLock = null;
        this.releaseVaultLock = null;

        try {
            releaseLock?.();
        } finally {
            releaseVaultLock?.();
        }
    }

    private releaseClientListeners(): void {
        const client = this.client;

        if (client) {
            client.off(ClientEvent.Sync, this.handleSync);
            client.off(MatrixEventEvent.Decrypted, this.handleDecrypted);
            client.off(RoomEvent.Timeline, this.handleTimeline);
            client.off(RoomEvent.Name, this.handleRoomChange);
            client.off(RoomEvent.Receipt, this.handleRoomChange);
            client.off(RoomEvent.MyMembership, this.handleRoomChange);
            client.off(RoomMemberEvent.Typing, this.handleTyping);
            client.off(CryptoEvent.VerificationRequestReceived, this.handleIncomingVerification);
        }

        if (this.derivedRefreshFrame !== null) {
            window.cancelAnimationFrame(this.derivedRefreshFrame);
            this.derivedRefreshFrame = null;
        }

        this.pendingTimelineRefresh = false;
        this.paginatingRoomId = null;
        this.readMarkerTargets.clear();
        this.readMarkerTasks.clear();
        this.lastReadEventIds.clear();
    }

    private releaseMediaAssets(): void {
        for (const entry of this.mediaAssets.values()) {
            this.releaseMediaEntry(entry);
        }

        for (const entry of this.gifPosters.values()) {
            this.releasePosterEntry(entry);
        }

        this.mediaAssets.clear();
        this.gifPosters.clear();
        this.mediaAliases.clear();
        this.mediaCacheBytes = 0;
    }
}
