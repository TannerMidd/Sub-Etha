import {
    ClientEvent,
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
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api";
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
import { AuthType, type UIAuthCallback } from "matrix-js-sdk/lib/interactive-auth";
import {
    decryptAttachment,
    encryptAttachment,
    type IEncryptedFile,
} from "matrix-encrypt-attachment";
import { base64UrlToBytes, getSessionDeviceKeys, saveSession } from "./session-store";
import { EncryptedMatrixStore, MemoryDraftRepository } from "./encrypted-store";
import {
    clearCurrentAccountData,
    listenForStorageReset,
    prepareAccountCleanup,
} from "./storage-cleanup";
import { humanizeMatrixError } from "./auth";
import { assertAllowedHomeserverUrl } from "./url-policy";
import {
    assertMediaByteLength,
    assertDeclaredMediaLimits,
    assertSafeImageBytes,
    imageDimensions,
    MAX_CONCURRENT_MEDIA_LOADS,
    MAX_MEDIA_BYTES,
    MAX_MEDIA_CACHE_BYTES,
    MAX_MEDIA_CACHE_ENTRIES,
    MediaLimitError,
    MediaTimeoutError,
    normalizeMediaFile,
    readBoundedResponse,
    type MediaExpectedKind,
} from "./media";
import { normalizeRooms, normalizeTimeline } from "./normalize";
import { createMediaContent, createTextContent } from "./message-content";
import type {
    CleanupOutcome,
    DraftRepository,
    DeviceSummary,
    DeviceVerificationState,
    MatrixMediaRef,
    MatrixSnapshot,
    MediaAsset,
    PersistedMatrixSession,
    TimelineItem,
    StorageMode,
} from "./types";
import { INITIAL_TIMELINE_ITEM_INDEX, timelineStartIndexAfterPrepend } from "../timeline-window";

type Listener = () => void;

export class MatrixAlreadyOpenError extends Error {
    constructor() {
        super("Sub-Etha is already tuned to this account in another tab.");
    }
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

interface ActiveVerification {
    request: VerificationRequest;
    direction: "incoming" | "outgoing";
    verifierStarted: boolean;
    verifier: Verifier | null;
    sasCallbacks: ShowSasCallbacks | null;
    requestChange: () => void;
    showSas: ((callbacks: ShowSasCallbacks) => void) | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function uiaStages(value: unknown): string[][] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.flatMap((flow) => {
        if (!isRecord(flow) || !Array.isArray(flow.stages)) {
            return [];
        }

        const stages = flow.stages.filter((stage): stage is string => typeof stage === "string");

        return stages.length === flow.stages.length ? [stages] : [];
    });
}

function hasPublishedCrossSigningIdentity(
    result: {
        master_keys?: Record<string, unknown>;
        self_signing_keys?: Record<string, unknown>;
        user_signing_keys?: Record<string, unknown>;
    },
    userId: string,
): boolean {
    return Boolean(
        result.master_keys?.[userId] &&
        result.self_signing_keys?.[userId] &&
        result.user_signing_keys?.[userId],
    );
}

interface MediaCacheEntry<T> {
    promise: Promise<T>;
    byteLength: number;
    lastUsed: number;
    settled: boolean;
    released: boolean;
    controller?: AbortController;
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
}

async function acquireExclusiveLock(name: string): Promise<(() => void) | null> {
    if (!("locks" in navigator)) {
        return () => undefined;
    }

    let releaseLock: (() => void) | undefined;
    let resolveAcquired: (acquired: boolean) => void = () => undefined;
    const acquired = new Promise<boolean>((resolve) => {
        resolveAcquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
        releaseLock = resolve;
    });

    void navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
        resolveAcquired(Boolean(lock));

        if (lock) {
            await held;
        }
    });

    if (!(await acquired)) {
        return null;
    }

    return () => releaseLock?.();
}

async function messageInfo(file: File): Promise<Record<string, unknown>> {
    const info: Record<string, unknown> = {
        size: file.size,
        mimetype: file.type || "application/octet-stream",
    };
    const dimensions = await imageDimensions(file);

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
    private store: MemoryStore | EncryptedMatrixStore | null = null;
    private session: PersistedMatrixSession;
    private snapshot: MatrixSnapshot;
    private listeners = new Set<Listener>();
    private releaseLock: (() => void) | null = null;
    private mediaAssets = new Map<string, MediaCacheEntry<MediaAsset>>();
    private gifPosters = new Map<string, MediaCacheEntry<PosterAsset | null>>();
    private mediaCacheBytes = 0;
    private mediaCacheClock = 0;
    private activeMediaLoads = 0;
    private mediaLoadWaiters: Array<() => void> = [];
    private secretStorageKey: [string, Uint8Array<ArrayBuffer>] | null = null;
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
    readonly storageMode: StorageMode;
    drafts: DraftRepository;
    private releaseStorageResetListener: (() => void) | null = null;

    constructor(session: PersistedMatrixSession) {
        this.session = session;
        this.storageMode = session.storageMode;
        this.drafts = new MemoryDraftRepository();
        this.snapshot = emptySnapshot(session);
    }

    subscribe = (listener: Listener): (() => void) => {
        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    };

    getSnapshot = (): MatrixSnapshot => this.snapshot;

    private emit(next: Partial<MatrixSnapshot> = {}): void {
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

    private async refreshTokens(refreshToken: string) {
        this.session.baseUrl = assertAllowedHomeserverUrl(this.session.baseUrl);

        if (this.session.authKind === "oauth" && this.session.oauth) {
            const oauth = new OAuth2(this.session.oauth.metadata, {
                clientId: this.session.oauth.clientId,
                deviceId: this.session.oauth.deviceId,
                redirectUri: this.session.oauth.redirectUri,
            });
            const response = await oauth.performRefreshTokenGrant(refreshToken);

            this.session = {
                ...this.session,
                accessToken: response.access_token,
                refreshToken: response.refresh_token ?? refreshToken,
                expiresAt: response.expires_in
                    ? Date.now() + response.expires_in * 1000
                    : undefined,
            };
        } else {
            const response = await createClient({
                baseUrl: this.session.baseUrl,
                disableVoip: true,
            }).refreshToken(refreshToken);

            this.session = {
                ...this.session,
                accessToken: response.access_token,
                refreshToken: response.refresh_token ?? refreshToken,
                expiresAt: Date.now() + response.expires_in_ms,
            };
        }

        await saveSession(this.session);

        return {
            accessToken: this.session.accessToken,
            refreshToken: this.session.refreshToken,
            expiry: this.session.expiresAt ? new Date(this.session.expiresAt) : undefined,
        };
    }

    async start(): Promise<void> {
        this.session.baseUrl = assertAllowedHomeserverUrl(this.session.baseUrl);
        const storageId = this.session.localStoreId;

        this.releaseLock = await acquireExclusiveLock(`sub-etha-matrix-${storageId}`);

        if (!this.releaseLock) {
            throw new MatrixAlreadyOpenError();
        }

        if (this.storageMode === "remembered") {
            const keys = await getSessionDeviceKeys();
            const encryptedStore = new EncryptedMatrixStore(storageId, keys);

            this.store = encryptedStore;
            this.drafts = encryptedStore.drafts;
        } else {
            this.store = new MemoryStore();
            this.drafts = new MemoryDraftRepository();
        }

        const scheduler = new MatrixScheduler();

        this.client = createClient({
            baseUrl: this.session.baseUrl,
            userId: this.session.userId,
            deviceId: this.session.deviceId,
            accessToken: this.session.accessToken,
            refreshToken: this.session.refreshToken,
            tokenRefreshFunction: (token) => this.refreshTokens(token),
            store: this.store,
            scheduler,
            timelineSupport: true,
            disableVoip: true,
            localTimeoutMs: 30_000,
            verificationMethods: ["m.sas.v1"],
            cryptoCallbacks: {
                getSecretStorageKey: async ({ keys }) => {
                    if (this.secretStorageKey && keys[this.secretStorageKey[0]]) {
                        return this.secretStorageKey;
                    }

                    return null;
                },
                cacheSecretStorageKey: (keyId, _keyInfo, key) => {
                    this.secretStorageKey = [keyId, key];
                },
            },
        });

        await this.store.startup();

        if (this.storageMode === "remembered") {
            await this.client.initRustCrypto({
                useIndexedDB: true,
                cryptoDatabasePrefix: this.session.cryptoDatabasePrefix,
                storageKey: base64UrlToBytes(this.session.cryptoStorageKey),
            });
        } else {
            await this.client.initRustCrypto({
                useIndexedDB: false,
            });
        }

        this.client.on(ClientEvent.Sync, this.handleSync);
        this.client.on(MatrixEventEvent.Decrypted, this.handleDecrypted);
        this.client.on(RoomEvent.Timeline, this.handleTimeline);
        this.client.on(RoomEvent.Name, this.handleRoomChange);
        this.client.on(RoomEvent.Receipt, this.handleRoomChange);
        this.client.on(RoomEvent.MyMembership, this.handleRoomChange);
        this.client.on(RoomMemberEvent.Typing, this.handleTyping);
        this.client.on(CryptoEvent.VerificationRequestReceived, this.handleIncomingVerification);
        window.addEventListener("storage", this.handleTakeoverRequest);
        this.releaseStorageResetListener = listenForStorageReset(async () => {
            this.stop();
            await this.store?.destroy();
        });

        this.client.startClient({
            initialSyncLimit: 30,
            lazyLoadMembers: true,
            pendingEventOrdering: "chronological" as never,
            disablePresence: true,
            clientWellKnownPollPeriod: 6 * 60 * 60,
        });
        this.refreshDerivedState();
        void this.refreshOwnProfile();
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

        this.emit({
            connection: "idle",
            error: "This receiver was safely released for another tab.",
        });
        this.stop();
    };

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
        this.releaseVerificationContext();
        const requestChange = () => this.handleVerificationChange(request);
        const context: ActiveVerification = {
            request,
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

            if (this.activeVerification !== context) {
                return;
            }

            context.verifier = verifier;

            const showSas = (callbacks: ShowSasCallbacks) => {
                if (this.activeVerification !== context) {
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

            if (this.activeVerification === context) {
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

    private releaseVerificationContext(): void {
        const context = this.activeVerification;

        if (!context) {
            return;
        }

        context.request.off(VerificationRequestEvent.Change, context.requestChange);

        if (context.verifier && context.showSas) {
            context.verifier.off(VerifierEvent.ShowSas, context.showSas);
        }

        this.activeVerification = null;
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
            hasMoreHistory: Boolean(room && room.oldState.paginationToken !== null),
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
            hasMoreHistory: Boolean(room && room.oldState.paginationToken !== null),
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
                hasMoreHistory: room.oldState.paginationToken !== null,
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

        const file = await normalizeMediaFile(sourceFile);
        const encrypted = room.hasEncryptionStateEvent();
        let uploadBody: Blob = file;
        let encryptedFile: IEncryptedFile | undefined;

        if (encrypted) {
            const result = await encryptAttachment(await file.arrayBuffer());

            uploadBody = new Blob([result.data], { type: "application/octet-stream" });
            encryptedFile = result.info;
        }

        const uploadPromise = client.uploadContent(uploadBody, {
            name: file.name,
            type: encrypted ? "application/octet-stream" : file.type,
            progressHandler: (progress) => {
                const total = progress.total || file.size;

                onProgress?.(total ? Math.round((progress.loaded / total) * 100) : 0);
            },
        });

        onCancellable?.(() => {
            client.cancelUpload(uploadPromise);
        });
        const upload = await uploadPromise.finally(() => onCancellable?.(null));
        const content = createMediaContent({
            fileName: file.name,
            mimeType: file.type,
            contentUri: upload.content_uri,
            info: await messageInfo(file),
            caption: options.caption,
            replyTo: options.replyTo,
            encryptedFile: encryptedFile as unknown as Record<string, unknown> | undefined,
        });

        await client.sendMessage(roomId, content as never);
    }

    async getMediaAsset(
        media: MatrixMediaRef,
        options: MediaRequestOptions = {},
    ): Promise<MediaAsset> {
        assertDeclaredMediaLimits(media);
        const key = [
            options.cacheKey ?? media.mxcUrl,
            options.width ?? "full",
            options.height ?? "full",
            options.resizeMethod ?? "scale",
            options.expectedKind ?? "unknown",
        ].join("|");
        const existing = this.mediaAssets.get(key);

        if (existing) {
            this.touchCacheEntry(this.mediaAssets, key, existing);

            return existing.promise;
        }

        this.ensureMediaCacheSlot();
        const controller = new AbortController();
        const entry: MediaCacheEntry<MediaAsset> = {
            promise: Promise.resolve(null as unknown as MediaAsset),
            byteLength: 0,
            lastUsed: ++this.mediaCacheClock,
            settled: false,
            released: false,
            controller,
        };

        entry.promise = this.withMediaLoadSlot(
            () => this.loadMedia(media, options, controller.signal),
            controller.signal,
        );
        this.mediaAssets.set(key, entry);

        try {
            const asset = await entry.promise;

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
            }

            entry.released = true;

            throw error;
        }
    }

    invalidateMedia(media: MatrixMediaRef, cacheKey?: string): void {
        const prefix = cacheKey ?? media.mxcUrl;

        for (const [key, entry] of this.mediaAssets) {
            if (!key.startsWith(`${prefix}|`)) {
                continue;
            }

            this.mediaAssets.delete(key);
            this.releaseMediaEntry(entry);
        }

        for (const [key, entry] of this.gifPosters) {
            if (!key.startsWith(`${prefix}|`)) {
                continue;
            }

            this.gifPosters.delete(key);
            this.releasePosterEntry(entry);
        }
    }

    async getGifPoster(media: MatrixMediaRef, cacheKey?: string): Promise<string | null> {
        const key = `${cacheKey ?? media.mxcUrl}|poster`;
        const existing = this.gifPosters.get(key);

        if (existing) {
            this.touchCacheEntry(this.gifPosters, key, existing);

            return (await existing.promise)?.url ?? null;
        }

        this.ensureMediaCacheSlot();
        const controller = new AbortController();
        const entry: MediaCacheEntry<PosterAsset | null> = {
            promise: Promise.resolve(null),
            byteLength: 0,
            lastUsed: ++this.mediaCacheClock,
            settled: false,
            released: false,
            controller,
        };

        entry.promise = this.createGifPoster(media, cacheKey, controller.signal);
        this.gifPosters.set(key, entry);
        const poster = await entry.promise;

        entry.settled = true;

        if (this.gifPosters.get(key) === entry && !entry.released) {
            entry.byteLength = poster?.byteLength ?? 0;
            this.mediaCacheBytes += entry.byteLength;
            this.evictMediaCache("poster", key);
        }

        return poster?.url ?? null;
    }

    private async createGifPoster(
        media: MatrixMediaRef,
        cacheKey?: string,
        signal?: AbortSignal,
    ): Promise<PosterAsset | null> {
        if (typeof document === "undefined") {
            return null;
        }

        try {
            signal?.throwIfAborted();
            const asset = await this.getMediaAsset(media, { cacheKey, expectedKind: "image" });

            signal?.throwIfAborted();
            let source: CanvasImageSource;
            let width: number;
            let height: number;
            let releaseSource: () => void = () => undefined;

            if ("createImageBitmap" in globalThis) {
                const bitmap = await createImageBitmap(asset.blob);

                source = bitmap;
                width = bitmap.width;
                height = bitmap.height;
                releaseSource = () => bitmap.close();
            } else {
                const image = new Image();

                image.src = asset.url;
                await image.decode();
                source = image;
                width = image.naturalWidth;
                height = image.naturalHeight;
            }

            const scale = Math.min(1, 1000 / Math.max(width, height));
            const canvas = document.createElement("canvas");

            canvas.width = Math.max(1, Math.round(width * scale));
            canvas.height = Math.max(1, Math.round(height * scale));
            canvas.getContext("2d")?.drawImage(source, 0, 0, canvas.width, canvas.height);
            releaseSource();
            const blob = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, "image/png"),
            );

            signal?.throwIfAborted();

            return blob ? { url: URL.createObjectURL(blob), byteLength: blob.size } : null;
        } catch {
            return null;
        }
    }

    private async loadMedia(
        media: MatrixMediaRef,
        options: MediaRequestOptions = {},
        signal?: AbortSignal,
    ): Promise<MediaAsset> {
        assertDeclaredMediaLimits(media);
        const deadlineController = new AbortController();
        const onAbort = () => deadlineController.abort(signal?.reason);

        signal?.addEventListener("abort", onAbort, { once: true });
        const deadline = setTimeout(() => {
            deadlineController.abort(new MediaTimeoutError());
        }, 30_000);
        const client = this.requireClient();
        const useThumbnail = !media.encryptedFile && options.width && options.height;
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

        try {
            let response = await fetch(authenticatedUrl, {
                headers: mediaAuthorizationHeaders(
                    authenticatedUrl,
                    client.getHomeserverUrl(),
                    token,
                ),
                cache: "no-store",
                signal: deadlineController.signal,
            });

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
                    response = await fetch(legacyUrl, {
                        cache: "no-store",
                        signal: deadlineController.signal,
                    });
                }
            }

            if (!response.ok) {
                throw new Error(`Media download failed (${response.status}).`);
            }

            let bytes = await readBoundedResponse(response, MAX_MEDIA_BYTES, {
                signal: deadlineController.signal,
            });

            if (media.encryptedFile) {
                bytes = await decryptAttachment(
                    bytes,
                    media.encryptedFile as unknown as IEncryptedFile,
                );
            }

            deadlineController.signal.throwIfAborted();
            assertMediaByteLength(bytes.byteLength, MAX_MEDIA_BYTES);
            const byteView = new Uint8Array(bytes);
            const imageSafety =
                options.expectedKind === "image" ? assertSafeImageBytes(byteView) : null;
            const mimeType =
                imageSafety?.mimeType ??
                media.mimeType ??
                response.headers.get("content-type")?.split(";")[0] ??
                "application/octet-stream";
            const blob = new Blob([bytes], { type: mimeType });

            return {
                url: URL.createObjectURL(blob),
                blob,
                mimeType,
                animated: imageSafety?.animated ?? false,
            };
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
        }
    }

    private async withMediaLoadSlot<T>(
        operation: () => Promise<T>,
        signal: AbortSignal,
    ): Promise<T> {
        if (this.activeMediaLoads >= MAX_CONCURRENT_MEDIA_LOADS) {
            await new Promise<void>((resolve, reject) => {
                const resume = () => {
                    signal.removeEventListener("abort", abort);
                    resolve();
                };

                const abort = () => {
                    const index = this.mediaLoadWaiters.indexOf(resume);

                    if (index >= 0) {
                        this.mediaLoadWaiters.splice(index, 1);
                    }

                    reject(signal.reason);
                };

                signal.addEventListener("abort", abort, { once: true });
                this.mediaLoadWaiters.push(resume);
            });
        }

        signal.throwIfAborted();
        this.activeMediaLoads += 1;

        try {
            return await operation();
        } finally {
            this.activeMediaLoads -= 1;
            this.mediaLoadWaiters.shift()?.();
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
            if (protectedKind === "media" && protectedKey === key) {
                continue;
            }

            if (!candidate || entry.lastUsed < candidate.lastUsed) {
                candidate = { kind: "media", key, lastUsed: entry.lastUsed };
            }
        }

        for (const [key, entry] of this.gifPosters) {
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

        void entry.promise.then((asset) => URL.revokeObjectURL(asset.url)).catch(() => undefined);
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

        void entry.promise
            .then((poster) => {
                if (poster) {
                    URL.revokeObjectURL(poster.url);
                }
            })
            .catch(() => undefined);
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

        if (displayName.trim()) {
            await client.setDisplayName(displayName.trim());
        }

        if (avatar) {
            const upload = await client.uploadContent(avatar, {
                name: avatar.name,
                type: avatar.type,
            });

            await client.setAvatarUrl(upload.content_uri);
        }

        this.refreshDerivedState(true);
        await this.refreshOwnProfile();
    }

    async getDevices(): Promise<DeviceSummary[]> {
        const client = this.requireClient();
        const cryptoApi = client.getCrypto();
        const response = await client.getDevices();

        return Promise.all(
            response.devices.map(async (device) => {
                const trust = await cryptoApi
                    ?.getDeviceVerificationStatus(this.session.userId, device.device_id)
                    .catch(() => null);

                return {
                    deviceId: device.device_id,
                    displayName: device.display_name || "Unnamed device",
                    lastSeenTs: device.last_seen_ts,
                    lastSeenIp: device.last_seen_ip,
                    current: device.device_id === this.session.deviceId,
                    verified: trust?.isVerified() ?? false,
                };
            }),
        );
    }

    async getCryptoStatus() {
        const client = this.requireClient();
        const cryptoApi = client.getCrypto();

        if (!cryptoApi) {
            return {
                secretStorageReady: false,
                crossSigningConfigured: false,
                crossSigningReady: false,
                backupVersion: null,
            };
        }

        const [secretStatus, crossSigning, backupVersion, publishedKeys] = await Promise.all([
            cryptoApi.getSecretStorageStatus(),
            cryptoApi.getCrossSigningStatus(),
            cryptoApi.getActiveSessionBackupVersion(),
            client.downloadKeysForUsers([this.session.userId]).catch(() => null),
        ]);

        return {
            secretStorageReady: secretStatus.ready,
            crossSigningConfigured: publishedKeys
                ? hasPublishedCrossSigningIdentity(publishedKeys, this.session.userId)
                : crossSigning.publicKeysOnDevice,
            crossSigningReady:
                crossSigning.publicKeysOnDevice &&
                (crossSigning.privateKeysInSecretStorage ||
                    Object.values(crossSigning.privateKeysCachedLocally).every(Boolean)),
            backupVersion,
        };
    }

    private deviceSigningAuthentication(accountPassword?: string): UIAuthCallback<void> {
        return async (makeRequest) => {
            try {
                return await makeRequest(null);
            } catch (error) {
                const data = isRecord(error) && isRecord(error.data) ? error.data : null;
                const session = typeof data?.session === "string" ? data.session : null;
                const completed = new Set(
                    Array.isArray(data?.completed)
                        ? data.completed.filter(
                              (stage): stage is string => typeof stage === "string",
                          )
                        : [],
                );
                const flows = uiaStages(data?.flows);
                const canCompleteWith = (stage: string) =>
                    flows.some((flow) =>
                        flow.every((required) => completed.has(required) || required === stage),
                    );

                if (!session || !flows.length) {
                    throw error;
                }

                if (canCompleteWith(AuthType.Dummy)) {
                    return makeRequest({ type: AuthType.Dummy, session });
                }

                if (canCompleteWith(AuthType.Password)) {
                    if (!accountPassword) {
                        throw new Error(
                            "Your homeserver requires your Matrix account password to enable cross-signing. Enter it below and try again; Sub-Etha will not store it.",
                        );
                    }

                    try {
                        return await makeRequest({
                            type: AuthType.Password,
                            identifier: { type: "m.id.user", user: this.session.userId },
                            password: accountPassword,
                            session,
                        });
                    } catch (authError) {
                        throw new Error(
                            `Cross-signing authentication failed: ${humanizeMatrixError(authError)}`,
                        );
                    }
                }

                throw new Error(
                    "Your homeserver requires browser-based account authentication to enable cross-signing. Set up cross-signing in another Matrix client, then return here to verify this device.",
                );
            }
        };
    }

    async setupRecovery(passphrase?: string, accountPassword?: string): Promise<string> {
        const client = this.requireClient();
        const cryptoApi = client.getCrypto();

        if (!cryptoApi) {
            throw new Error("Encryption is not available on this device.");
        }

        const [crossSigning, publishedKeys] = await Promise.all([
            cryptoApi.getCrossSigningStatus(),
            client.downloadKeysForUsers([this.session.userId]),
        ]);
        const cachedCrossSigningKeys = Object.values(crossSigning.privateKeysCachedLocally).every(
            Boolean,
        );
        const crossSigningPublished = hasPublishedCrossSigningIdentity(
            publishedKeys,
            this.session.userId,
        );

        if (!crossSigningPublished) {
            await cryptoApi.bootstrapCrossSigning({
                // A failed UI-auth attempt can leave unpublished private keys in the Rust store.
                // Regenerate only that unpublished identity so a corrected password can retry.
                setupNewCrossSigning: crossSigning.publicKeysOnDevice || cachedCrossSigningKeys,
                authUploadDeviceSigningKeys: this.deviceSigningAuthentication(accountPassword),
            });

            const confirmedKeys = await client.downloadKeysForUsers([this.session.userId]);

            if (!hasPublishedCrossSigningIdentity(confirmedKeys, this.session.userId)) {
                throw new Error(
                    "The homeserver did not publish the new cross-signing identity. Recovery setup stopped before storing a partial configuration; try again.",
                );
            }
        } else if (!crossSigning.privateKeysInSecretStorage && !cachedCrossSigningKeys) {
            throw new Error(
                "Cross-signing already exists for this account, but its private keys are not available here. Verify this device with an existing trusted device before setting up recovery.",
            );
        }

        const generated = await cryptoApi.createRecoveryKeyFromPassphrase(
            passphrase?.trim() || undefined,
        );

        await cryptoApi.bootstrapSecretStorage({
            createSecretStorageKey: async () => generated,
            setupNewKeyBackup: true,
        });

        return (
            generated.encodedPrivateKey ??
            "Recovery storage was configured with the supplied passphrase."
        );
    }

    async unlockRecovery(secret: string): Promise<void> {
        const cryptoApi = this.requireClient().getCrypto();

        if (!cryptoApi) {
            throw new Error("Encryption is not available on this device.");
        }

        const status = await cryptoApi.getSecretStorageStatus();

        if (!status.defaultKeyId) {
            throw new Error("This account does not have a recovery key configured.");
        }

        const keyInfo = status.secretStorageKeyValidityMap;
        const keyTuple = await this.requireClient().secretStorage.getKey(status.defaultKeyId);
        const keyDescription = keyTuple?.[1];
        let key: Uint8Array<ArrayBuffer>;

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

        void keyInfo;
        this.secretStorageKey = [status.defaultKeyId, key];
        await cryptoApi.loadSessionBackupPrivateKeyFromSecretStorage();
        await cryptoApi.checkKeyBackupAndEnable();
    }

    async startDeviceVerification(deviceId?: string): Promise<void> {
        const client = this.requireClient();
        const cryptoApi = client.getCrypto();

        if (!cryptoApi) {
            throw new Error("Encryption is not available on this device.");
        }

        if (this.activeVerification?.request.pending) {
            throw new Error("A device verification is already in progress.");
        }

        let request: VerificationRequest;

        try {
            // Keep this path identical to the working production flow. The
            // Rust crypto API owns device-list refresh and recipient selection.
            request = deviceId
                ? await cryptoApi.requestDeviceVerification(this.session.userId, deviceId)
                : await cryptoApi.requestOwnUserVerification();
        } catch (error) {
            if (
                error instanceof Error &&
                /no existing cross-signing key|cross-signing.*not.*set up/i.test(error.message)
            ) {
                throw new Error(
                    "Cross-signing is not set up for this account yet. Set up recovery in Encryption & recovery before verifying another device.",
                    { cause: error },
                );
            }

            throw error;
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

    async prepareLogout(): Promise<void> {
        await prepareAccountCleanup(this.session);
    }

    async logout(): Promise<CleanupOutcome> {
        this.stopped = true;
        await this.prepareLogout();
        let remoteRevocationConfirmed = true;

        try {
            await this.client?.logout();
        } catch {
            remoteRevocationConfirmed = false;
        }

        this.releaseClientListeners();
        this.client?.stopClient();
        window.removeEventListener("storage", this.handleTakeoverRequest);
        this.releaseStorageResetListener?.();
        this.releaseStorageResetListener = null;
        await this.drafts.flush().catch(() => undefined);
        await this.store?.destroy().catch(() => undefined);
        const cleanup = await clearCurrentAccountData(this.session, remoteRevocationConfirmed);

        this.releaseMediaAssets();
        this.releaseVerificationContext();
        this.releaseLock?.();
        this.releaseLock = null;
        this.paginationRequestId += 1;
        this.paginatingRoomId = null;
        this.emit({
            connection: "idle",
            rooms: [],
            timeline: [],
            timelineStartIndex: INITIAL_TIMELINE_ITEM_INDEX,
            activeRoomId: null,
            loadingHistory: false,
            hasMoreHistory: false,
        });

        return cleanup;
    }

    stop(): void {
        this.stopped = true;
        this.releaseClientListeners();
        this.releaseStorageResetListener?.();
        this.releaseStorageResetListener = null;
        void this.drafts.flush();
        void this.store?.destroy();
        this.client?.stopClient();
        window.removeEventListener("storage", this.handleTakeoverRequest);
        this.releaseMediaAssets();
        this.releaseVerificationContext();
        this.releaseLock?.();
        this.releaseLock = null;
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
        this.mediaCacheBytes = 0;
    }
}
