import assert from "node:assert/strict";
import test from "node:test";
import { IDBDatabase as FakeIDBDatabase, IDBFactory } from "fake-indexeddb";
import { ClientEvent, MatrixClient, MemoryStore, OAuth2, SyncState } from "matrix-js-sdk";
import { encodeRecoveryKey } from "matrix-js-sdk/lib/crypto-api/recovery-key";
import {
    MatrixAlreadyOpenError,
    MatrixOwnershipUnavailableError,
    MatrixSessionRevocationUnconfirmedError,
    MatrixService,
    revokePendingMatrixSession,
} from "../lib/matrix/client";
import {
    createLockedSession,
    createSession,
    deleteSessionRecord,
    generateRecoveryKey,
    inspectSession,
    unlockSession,
    type SessionCleanupDescriptor,
    type SessionDeletionResult,
} from "../lib/matrix/session-store";
import type { MatrixSnapshot, PersistedMatrixSession, TimelineItem } from "../lib/matrix/types";

const SESSION: PersistedMatrixSession = {
    accessToken: "token",
    authKind: "token",
    baseUrl: "https://matrix.example",
    cryptoDatabasePrefix: "sub-etha-crypto-record-1",
    cryptoStorageKey: "AQID",
    deviceId: "DEVICE",
    userId: "@arthur:matrix.example",
};

function createService(onSessionInvalidated?: (error: Error) => void): MatrixService {
    let session = SESSION;

    return new MatrixService(
        {
            get session() {
                return session;
            },
            recordId: "record-1",
            revision: 1,
            cryptoDatabasePrefix: "sub-etha-crypto-record-1",
            reseal: async (nextSession: PersistedMatrixSession) => {
                session = nextSession;
            },
            dispose: () => undefined,
        } as never,
        onSessionInvalidated,
    );
}

function timelineItem(id: string): TimelineItem {
    return {
        id,
        type: "message",
        senderId: "@ford:matrix.example",
        senderName: "Ford",
        senderAvatarMxcUrl: null,
        body: id,
        timestamp: Date.now(),
        own: false,
        edited: false,
        redacted: false,
        encrypted: false,
        decryptionState: "ready",
        reactions: [],
        sendingStatus: null,
        readBy: [],
        event: timelineEvent(id) as unknown as TimelineItem["event"],
    };
}

function timelineEvent(id: string) {
    return {
        getType: () => "m.room.message",
        getRelation: () => undefined,
        getSender: () => "@ford:matrix.example",
        replacingEvent: () => undefined,
        getContent: () => ({ msgtype: "m.text", body: id }),
        getId: () => id,
        getTs: () => Date.now(),
        isDecryptionFailure: () => false,
        isEncrypted: () => false,
        isBeingDecrypted: () => false,
        status: null,
    };
}

function timelineRoom(roomId: string, token: string | null, ids: string[]) {
    const events = ids.map(timelineEvent);
    const historyState = { paginationToken: token };

    return {
        roomId,
        events,
        historyState,
        getLiveTimeline: () => ({
            getEvents: () => events,
            getState: () => historyState,
        }),
        getMember: () => ({ name: "Ford", getMxcAvatarUrl: () => null }),
        getMembers: () => [],
        hasUserReadEvent: () => false,
        decryptAllEvents: async () => undefined,
    };
}

function paginationInternals(service: MatrixService) {
    const internals = service as unknown as {
        client: {
            getRoom: (roomId: string) => ReturnType<typeof timelineRoom> | null;
            getUserId: () => string;
            scrollback: (room: ReturnType<typeof timelineRoom>, limit: number) => Promise<void>;
        };
        snapshot: MatrixSnapshot;
        stopped: boolean;
        decryptRoomTimeline: () => Promise<void>;
    };

    internals.decryptRoomTimeline = async () => undefined;

    return internals;
}

test("room read markers coalesce duplicates and advance to the newest event", async () => {
    const service = createService();
    const events = [{ getId: () => "$one" }, { getId: () => "$two" }];
    let currentEvent = events[0];
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    const room = {
        getLiveTimeline: () => ({ getEvents: () => [currentEvent] }),
        setUnreadNotificationCount: () => undefined,
    };
    const client = {
        getRoom: () => room,
        setRoomReadMarkers: async (_roomId: string, eventId: string) => {
            calls.push(eventId);
            await new Promise<void>((resolve) => releases.push(resolve));
        },
    };
    const internals = service as unknown as {
        client: typeof client;
        refreshDerivedState: () => void;
    };

    internals.client = client;
    internals.refreshDerivedState = () => undefined;

    const first = service.markRoomRead("!room:example");
    const duplicate = service.markRoomRead("!room:example");

    assert.deepEqual(calls, ["$one"]);
    currentEvent = events[1];
    const advanced = service.markRoomRead("!room:example");

    releases.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(calls, ["$one", "$two"]);
    releases.shift()?.();
    await Promise.all([first, duplicate, advanced]);

    await service.markRoomRead("!room:example");
    assert.deepEqual(calls, ["$one", "$two"]);
});

test("decryption events batch one active-timeline refresh without another sync", () => {
    const service = createService();
    const originalWindow = globalThis.window;
    let scheduled: FrameRequestCallback | null = null;
    const refreshes: boolean[] = [];

    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            requestAnimationFrame(callback: FrameRequestCallback) {
                scheduled = callback;

                return 42;
            },
        },
    });

    try {
        const internals = service as unknown as {
            handleDecrypted: (event: { getRoomId: () => string }) => void;
            refreshDerivedState: (includeTimeline: boolean) => void;
            snapshot: { activeRoomId: string };
        };

        internals.snapshot.activeRoomId = "!room:example";
        internals.refreshDerivedState = (includeTimeline) => refreshes.push(includeTimeline);
        internals.handleDecrypted({ getRoomId: () => "!room:example" });
        internals.handleDecrypted({ getRoomId: () => "!room:example" });
        assert.ok(scheduled);
        (scheduled as FrameRequestCallback)(0);
        assert.deepEqual(refreshes, [true]);
    } finally {
        if (originalWindow === undefined) {
            Reflect.deleteProperty(globalThis, "window");
        } else {
            Object.defineProperty(globalThis, "window", {
                configurable: true,
                value: originalWindow,
            });
        }
    }
});

test("back-pagination timeline events stay hidden until pagination emits its atomic snapshot", () => {
    const service = createService();
    const refreshes: boolean[] = [];
    const internals = service as unknown as {
        handleTimeline: (
            event: unknown,
            room: { roomId: string },
            toStartOfTimeline?: boolean,
        ) => void;
        paginatingRoomId: string | null;
        refreshDerivedState: (includeTimeline: boolean) => void;
        snapshot: { activeRoomId: string };
    };

    internals.snapshot.activeRoomId = "!room:example";
    internals.paginatingRoomId = "!room:example";
    internals.refreshDerivedState = (includeTimeline) => refreshes.push(includeTimeline);

    internals.handleTimeline({}, { roomId: "!room:example" }, true);
    assert.deepEqual(refreshes, []);

    internals.handleTimeline({}, { roomId: "!other:example" }, true);
    assert.deepEqual(refreshes, [false]);
});

test("pagination prepends one page, preserves the anchor, and stops at history exhaustion", async () => {
    const service = createService();
    const room = timelineRoom("!room:example", "page-1", ["$current-1", "$current-2"]);
    const internals = paginationInternals(service);
    let calls = 0;
    let releaseScrollback: () => void = () => undefined;

    internals.client = {
        getRoom: (roomId) => (roomId === room.roomId ? room : null),
        getUserId: () => SESSION.userId,
        scrollback: async (target, limit) => {
            calls += 1;
            assert.equal(limit, 40);
            await new Promise<void>((resolve) => {
                releaseScrollback = resolve;
            });
            target.events.unshift(timelineEvent("$older-1"), timelineEvent("$older-2"));
            target.historyState.paginationToken = null;
        },
    };
    internals.snapshot.activeRoomId = room.roomId;
    internals.snapshot.timeline = [timelineItem("$current-1"), timelineItem("$current-2")];
    internals.snapshot.hasMoreHistory = true;

    const firstRequest = service.paginate();
    const duplicateRequest = service.paginate();

    assert.equal(calls, 1);
    assert.equal(service.getSnapshot().loadingHistory, true);
    await duplicateRequest;
    releaseScrollback();
    await firstRequest;

    const snapshot = service.getSnapshot();

    assert.deepEqual(
        snapshot.timeline.map((item) => item.id),
        ["$older-1", "$older-2", "$current-1", "$current-2"],
    );
    assert.equal(snapshot.timelineStartIndex, 1_000_000 - 2);
    assert.equal(snapshot.loadingHistory, false);
    assert.equal(snapshot.hasMoreHistory, false);

    await service.paginate();
    assert.equal(calls, 1);
});

test("failed pagination remains retryable", async () => {
    const service = createService();
    const room = timelineRoom("!room:example", "page-1", ["$current"]);
    const internals = paginationInternals(service);
    let calls = 0;

    internals.client = {
        getRoom: () => room,
        getUserId: () => SESSION.userId,
        scrollback: async (target) => {
            calls += 1;

            if (calls === 1) {
                throw new Error("Receiver unavailable");
            }

            target.events.unshift(timelineEvent("$older"));
            target.historyState.paginationToken = null;
        },
    };
    internals.snapshot.activeRoomId = room.roomId;
    internals.snapshot.timeline = [timelineItem("$current")];
    internals.snapshot.hasMoreHistory = true;

    await service.paginate();
    assert.equal(service.getSnapshot().loadingHistory, false);
    assert.equal(service.getSnapshot().hasMoreHistory, true);
    assert.match(service.getSnapshot().error ?? "", /Receiver unavailable/);

    await service.paginate();
    assert.equal(calls, 2);
    assert.equal(service.getSnapshot().hasMoreHistory, false);
    assert.equal(service.getSnapshot().error, null);
    assert.deepEqual(
        service.getSnapshot().timeline.map((item) => item.id),
        ["$older", "$current"],
    );
});

test("a stale pagination request cannot overwrite a newly selected room", async () => {
    const service = createService();
    const oldRoom = timelineRoom("!old:example", "old-page", ["$old-current"]);
    const newRoom = timelineRoom("!new:example", "new-page", ["$new-current"]);
    const rooms = new Map([
        [oldRoom.roomId, oldRoom],
        [newRoom.roomId, newRoom],
    ]);
    const internals = paginationInternals(service);
    const releases = new Map<string, () => void>();
    const originalDocument = globalThis.document;

    internals.client = {
        getRoom: (roomId) => rooms.get(roomId) ?? null,
        getUserId: () => SESSION.userId,
        scrollback: async (target) => {
            await new Promise<void>((resolve) => releases.set(target.roomId, resolve));
            target.events.unshift(timelineEvent(`${target.roomId}-older`));
            target.historyState.paginationToken = null;
        },
    };
    internals.snapshot.activeRoomId = oldRoom.roomId;
    internals.snapshot.timeline = [timelineItem("$old-current")];
    internals.snapshot.hasMoreHistory = true;

    Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: { visibilityState: "hidden" },
    });

    try {
        const oldRequest = service.paginate();

        service.selectRoom(newRoom.roomId);
        const newRequest = service.paginate();

        releases.get(oldRoom.roomId)?.();
        await oldRequest;
        assert.equal(service.getSnapshot().activeRoomId, newRoom.roomId);
        assert.equal(service.getSnapshot().loadingHistory, true);
        assert.deepEqual(
            service.getSnapshot().timeline.map((item) => item.id),
            ["$new-current"],
        );

        releases.get(newRoom.roomId)?.();
        await newRequest;
        assert.deepEqual(
            service.getSnapshot().timeline.map((item) => item.id),
            [`${newRoom.roomId}-older`, "$new-current"],
        );
        assert.equal(service.getSnapshot().loadingHistory, false);
        assert.equal(service.getSnapshot().hasMoreHistory, false);
    } finally {
        if (originalDocument === undefined) {
            Reflect.deleteProperty(globalThis, "document");
        } else {
            Object.defineProperty(globalThis, "document", {
                configurable: true,
                value: originalDocument,
            });
        }
    }
});

test("persistent Matrix startup fails closed before Rust crypto when Web Locks are unavailable", async (t) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let disposeCalls = 0;
    const initRustCrypto = t.mock.method(MatrixClient.prototype, "initRustCrypto");
    const service = new MatrixService({
        session: SESSION,
        recordId: "record-no-locks",
        revision: 1,
        cryptoDatabasePrefix: "sub-etha-crypto-no-locks",
        reseal: async () => undefined,
        dispose: () => {
            disposeCalls += 1;
        },
    } as never);

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });

    try {
        await assert.rejects(service.start(), MatrixOwnershipUnavailableError);
        assert.equal(initRustCrypto.mock.callCount(), 0);
        assert.equal(disposeCalls, 1);
        service.stop();
        assert.equal(disposeCalls, 1);
    } finally {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    }
});

test("explicit Matrix MemoryStore never receives a localStorage backend", async () => {
    const store = new MemoryStore();

    assert.equal((store as unknown as { localStorage?: Storage }).localStorage, undefined);
    assert.equal(store.getFilterIdByName("sub-etha-test"), null);
    await store.startup();
    assert.equal(await store.getSavedSync(), null);
});

test("token refresh is serialized and sealed before refreshed credentials are published", async (t) => {
    let session: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        refreshToken: "refresh-old",
        oauth: {
            clientId: "client-id",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    let disposeCalls = 0;
    let refreshCalls = 0;
    let releaseReseal: () => void = () => undefined;
    const resealGate = new Promise<void>((resolve) => {
        releaseReseal = resolve;
    });
    const order: string[] = [];
    const lease = {
        get session() {
            return session;
        },
        recordId: "record-refresh",
        revision: 1,
        cryptoDatabasePrefix: "sub-etha-crypto-refresh",
        reseal: async (nextSession: PersistedMatrixSession) => {
            order.push("reseal-start");
            await resealGate;
            session = nextSession;
            order.push("reseal-finish");
        },
        dispose: () => {
            disposeCalls += 1;
        },
    };
    const service = new MatrixService(lease as never);

    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => {
        refreshCalls += 1;
        order.push("refresh-response");

        return {
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 60,
        };
    });

    const internals = service as unknown as {
        refreshTokens: (refreshToken: string) => Promise<{
            accessToken: string;
            refreshToken?: string;
            expiry?: Date;
        }>;
    };
    let published = false;
    const first = internals.refreshTokens("refresh-old").then((tokens) => {
        published = true;
        order.push("published");

        return tokens;
    });
    const second = internals.refreshTokens("refresh-old");

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, ["refresh-response", "reseal-start"]);
    assert.equal(published, false);
    assert.equal(refreshCalls, 1);

    releaseReseal();
    const [firstTokens, secondTokens] = await Promise.all([first, second]);

    assert.deepEqual(firstTokens, {
        accessToken: "access-new",
        refreshToken: "refresh-new",
        expiry: firstTokens.expiry,
    });
    assert.equal(firstTokens.expiry instanceof Date, true);
    assert.equal(secondTokens.accessToken, "access-new");
    assert.deepEqual(order, ["refresh-response", "reseal-start", "reseal-finish", "published"]);
    assert.equal(session.accessToken, "access-new");
    service.stop();
    service.stop();
    assert.equal(disposeCalls, 1);
});

test("a failed token reseal locks, disposes, and reports invalidation exactly once", async (t) => {
    const sealError = new Error("seal failed");
    const invalidations: Error[] = [];
    const revoked: string[] = [];
    let disposeCalls = 0;
    const session: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        refreshToken: "refresh-old",
        oauth: {
            clientId: "client-id",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    const service = new MatrixService(
        {
            session,
            recordId: "record-invalidated",
            revision: 1,
            cryptoDatabasePrefix: "sub-etha-crypto-invalidated",
            reseal: async () => {
                throw sealError;
            },
            dispose: () => {
                disposeCalls += 1;
            },
        } as never,
        (error) => {
            invalidations.push(error);
            service.stop();
        },
    );

    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => ({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 60,
    }));
    t.mock.method(
        OAuth2.prototype,
        "revokeToken",
        async (token: string, type?: "access_token" | "refresh_token") => {
            revoked.push(`${type}-${token}`);
        },
    );

    const refresh = (
        service as unknown as {
            refreshTokens: (refreshToken: string) => Promise<unknown>;
        }
    ).refreshTokens("refresh-old");

    await assert.rejects(refresh, sealError);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposeCalls, 1);
    assert.deepEqual(invalidations, [sealError]);
    assert.deepEqual(revoked, ["refresh_token-refresh-new", "access_token-access-new"]);
    service.stop();
    assert.equal(disposeCalls, 1);
    assert.deepEqual(invalidations, [sealError]);
});

test("an unconfirmed revoke after reseal failure surfaces a typed invalidation", async (t) => {
    const sealError = new Error("vault write failed");
    const invalidations: Error[] = [];
    const revoked: string[] = [];
    const session: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        refreshToken: "refresh-old",
        oauth: {
            clientId: "client-id",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    const service = new MatrixService(
        {
            session,
            recordId: "record-unconfirmed-invalidation",
            revision: 1,
            cryptoDatabasePrefix: "sub-etha-crypto-unconfirmed-invalidation",
            reseal: async () => {
                throw sealError;
            },
            dispose: () => undefined,
        } as never,
        (error) => invalidations.push(error),
    );

    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => ({
        access_token: "access-unconfirmed",
        refresh_token: "refresh-unconfirmed",
        expires_in: 60,
    }));
    t.mock.method(
        OAuth2.prototype,
        "revokeToken",
        async (token: string, type?: "access_token" | "refresh_token") => {
            revoked.push(`${type}-${token}`);

            if (type === "refresh_token") {
                throw new Error("revocation unavailable");
            }
        },
    );

    const refresh = (
        service as unknown as {
            refreshTokens: (refreshToken: string) => Promise<unknown>;
        }
    ).refreshTokens("refresh-old");

    await assert.rejects(refresh, MatrixSessionRevocationUnconfirmedError);
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0] instanceof MatrixSessionRevocationUnconfirmedError, true);
    assert.equal(
        (invalidations[0] as MatrixSessionRevocationUnconfirmedError).remoteSessionEnded,
        false,
    );
    assert.equal(invalidations[0]?.cause, sealError);
    assert.deepEqual(revoked, [
        "refresh_token-refresh-unconfirmed",
        "access_token-access-unconfirmed",
    ]);
});

test("a refresh timeout locks with a typed warning signal before late revocation fails", async (t) => {
    const invalidations: Error[] = [];
    const revoked: string[] = [];
    let disposeCalls = 0;
    let releaseRefresh = (): void => undefined;
    let reportRefreshStarted = (): void => undefined;
    let reportLateRevocationAttempted = (): void => undefined;
    const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
        reportRefreshStarted = resolve;
    });
    const lateRevocationAttempted = new Promise<void>((resolve) => {
        reportLateRevocationAttempted = resolve;
    });
    const session: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        refreshToken: "refresh-timeout-old",
        oauth: {
            clientId: "client-id",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    const service = new MatrixService(
        {
            session,
            recordId: "record-refresh-timeout",
            revision: 1,
            cryptoDatabasePrefix: "sub-etha-crypto-refresh-timeout",
            reseal: async () => undefined,
            dispose: () => {
                disposeCalls += 1;
            },
        } as never,
        (error) => invalidations.push(error),
    );

    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => {
        reportRefreshStarted();
        await refreshGate;

        return {
            access_token: "access-timeout-late",
            refresh_token: "refresh-timeout-late",
            expires_in: 60,
        };
    });
    t.mock.method(
        OAuth2.prototype,
        "revokeToken",
        async (token: string, type?: "access_token" | "refresh_token") => {
            revoked.push(`${type}-${token}`);

            if (revoked.length === 2) {
                reportLateRevocationAttempted();
            }

            throw new Error("late revocation unavailable");
        },
    );

    const internals = service as unknown as {
        remoteRefreshTimeoutMs: number;
        refreshTokens: (refreshToken: string) => Promise<unknown>;
    };

    internals.remoteRefreshTimeoutMs = 1;

    const refreshResult = internals
        .refreshTokens("refresh-timeout-old")
        .catch((error: unknown) => error);

    await refreshStarted;
    const refreshError = await refreshResult;

    assert.equal(refreshError instanceof MatrixSessionRevocationUnconfirmedError, true);
    assert.deepEqual(invalidations, [refreshError]);
    assert.match(((refreshError as Error).cause as Error).message, /refresh timed out/i);
    assert.equal(service.getSnapshot().userId, "");
    assert.equal(service.getSnapshot().deviceId, "");

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(disposeCalls, 1);

    releaseRefresh();
    await lateRevocationAttempted;
    assert.deepEqual(revoked, [
        "refresh_token-refresh-timeout-late",
        "access_token-access-timeout-late",
    ]);
    assert.equal(invalidations.length, 1);
});

test("stop during a remote token refresh prevents any late reseal or publication", async (t) => {
    const session: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        refreshToken: "refresh-old",
        oauth: {
            clientId: "client-id",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    let releaseRefresh: () => void = () => undefined;
    let reportRefreshStarted: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
        reportRefreshStarted = resolve;
    });
    let resealCalls = 0;
    let disposeCalls = 0;
    const service = new MatrixService({
        session,
        recordId: "stopped-refresh-record",
        revision: 1,
        cryptoDatabasePrefix: "stopped-refresh-prefix",
        reseal: async () => {
            resealCalls += 1;
        },
        dispose: () => {
            disposeCalls += 1;
        },
    } as never);

    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => {
        reportRefreshStarted();
        await refreshGate;

        return {
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 60,
        };
    });

    const refresh = (
        service as unknown as {
            refreshTokens: (refreshToken: string) => Promise<unknown>;
        }
    ).refreshTokens("refresh-old");
    const refreshResult = refresh.catch((error: unknown) => error);

    await refreshStarted;
    service.stop();
    releaseRefresh();
    const refreshError = await refreshResult;

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match((refreshError as Error).message, /locked during token refresh/i);
    assert.equal(resealCalls, 0);
    assert.equal(disposeCalls, 1);
    assert.equal(service.getSnapshot().userId, "");
    assert.equal(service.getSnapshot().deviceId, "");
});

test("takeover during refresh reports typed uncertainty when rotated credentials cannot be revoked", async (t) => {
    const invalidations: Error[] = [];
    let releaseRefresh = (): void => undefined;
    let reportRefreshStarted = (): void => undefined;
    const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
        reportRefreshStarted = resolve;
    });
    const service = new MatrixService(
        {
            session: {
                ...SESSION,
                authKind: "oauth",
                refreshToken: "takeover-refresh-old",
                oauth: {
                    clientId: "takeover-client",
                    deviceId: "DEVICE",
                    redirectUri: "https://sub-etha.example/",
                    metadata: {} as never,
                },
            },
            recordId: "takeover-refresh-record",
            revision: 1,
            cryptoDatabasePrefix: "takeover-refresh-prefix",
            reseal: async () => undefined,
            dispose: () => undefined,
        } as never,
        (error) => invalidations.push(error),
    );

    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => {
        reportRefreshStarted();
        await refreshGate;

        return {
            access_token: "takeover-access-new",
            refresh_token: "takeover-refresh-new",
            expires_in: 60,
        };
    });
    t.mock.method(OAuth2.prototype, "revokeToken", async () => {
        throw new Error("takeover revocation unavailable");
    });

    const internals = service as unknown as {
        refreshTokens: (refreshToken: string) => Promise<unknown>;
        handleTakeoverRequest: (event: StorageEvent) => void;
    };
    const refreshResult = internals
        .refreshTokens("takeover-refresh-old")
        .catch((error: unknown) => error);

    await refreshStarted;
    internals.handleTakeoverRequest({
        key: "sub-etha-account-takeover",
        newValue: "another-tab",
    } as StorageEvent);
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0] instanceof MatrixSessionRevocationUnconfirmedError, false);

    releaseRefresh();
    const refreshError = await refreshResult;

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.match((refreshError as Error).message, /locked during token refresh/i);
    assert.equal(invalidations.length, 2);
    assert.equal(invalidations[1] instanceof MatrixSessionRevocationUnconfirmedError, true);
    assert.equal(
        (invalidations[1] as MatrixSessionRevocationUnconfirmedError).remoteSessionEnded,
        false,
    );
});

test("a refresh response after tombstone is revoked before logout is confirmed", async (t) => {
    let session: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        accessToken: "access-old",
        refreshToken: "refresh-old",
        oauth: {
            clientId: "client-id",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    let releaseRefresh: () => void = () => undefined;
    let reportRefreshStarted: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
        reportRefreshStarted = resolve;
    });
    const order: string[] = [];
    const cleanup: SessionCleanupDescriptor = {
        kind: "cleanup",
        recordId: "refresh-logout-record",
        revision: 3,
        scope: "exact",
        cryptoDatabasePrefix: "refresh-logout-prefix",
    };
    let disposed = false;
    const lease = {
        get session() {
            if (disposed) {
                throw new Error("disposed");
            }

            return session;
        },
        recordId: "refresh-logout-record",
        revision: 2,
        cryptoDatabasePrefix: "refresh-logout-prefix",
        reseal: async (nextSession: PersistedMatrixSession) => {
            if (disposed) {
                throw new Error("disposed");
            }

            session = nextSession;
            order.push("reseal");
        },
        dispose: () => {
            disposed = true;
        },
    };
    const service = new MatrixService(lease as never);

    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => {
        reportRefreshStarted();
        await refreshGate;

        return {
            access_token: "access-new",
            refresh_token: "refresh-new",
            expires_in: 60,
        };
    });
    t.mock.method(
        OAuth2.prototype,
        "revokeToken",
        async (token: string, type?: "access_token" | "refresh_token") => {
            order.push(`revoke-${type}-${token}`);
        },
    );

    const internals = service as unknown as {
        refreshTokens: (refreshToken: string) => Promise<unknown>;
        deleteCurrentSession: () => Promise<SessionDeletionResult>;
        cleanupCurrentSessionDatabases: () => Promise<void>;
        completeCurrentSessionCleanup: () => Promise<void>;
    };

    internals.deleteCurrentSession = async () => {
        order.push("record-tombstone");
        lease.dispose();

        return { cleanup, session };
    };

    internals.cleanupCurrentSessionDatabases = async () => {
        order.push("database-cleanup");
    };

    internals.completeCurrentSessionCleanup = async () => {
        order.push("cleanup-complete");
    };

    const refresh = internals.refreshTokens("refresh-old");
    const refreshResult = refresh.catch((error: unknown) => error);

    await refreshStarted;
    const logout = service.logout();

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(order, [
        "record-tombstone",
        "revoke-refresh_token-refresh-old",
        "revoke-access_token-access-old",
    ]);

    releaseRefresh();

    const refreshError = await refreshResult;

    const logoutResult = await logout;

    assert.deepEqual(logoutResult, { remoteSessionEnded: true });
    assert.match((refreshError as Error).message, /locked during token refresh/i);
    assert.deepEqual(order, [
        "record-tombstone",
        "revoke-refresh_token-refresh-old",
        "revoke-access_token-access-old",
        "revoke-refresh_token-refresh-new",
        "revoke-access_token-access-new",
        "database-cleanup",
        "cleanup-complete",
    ]);
});

test("logout waits for an enqueued reseal and revokes the final OAuth credentials", async (t) => {
    const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let lockTail: Promise<unknown> = Promise.resolve();
    let releaseEncryption = (): void => undefined;
    let reportEncryptionStarted = (): void => undefined;
    const encryptionGate = new Promise<void>((resolve) => {
        releaseEncryption = resolve;
    });
    const encryptionStarted = new Promise<void>((resolve) => {
        reportEncryptionStarted = resolve;
    });

    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: new IDBFactory(),
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (
                    name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => Promise<unknown>,
                ) => {
                    const result = lockTail.then(() => callback({ name } as Lock));

                    lockTail = result.then(
                        () => undefined,
                        () => undefined,
                    );

                    return result;
                },
            },
        },
    });

    try {
        const original: PersistedMatrixSession = {
            ...createSession({
                accessToken: "queued-access-old",
                authKind: "oauth",
                baseUrl: "https://matrix.example",
                deviceId: "QUEUED_DEVICE",
                oauth: {
                    clientId: "queued-client",
                    deviceId: "QUEUED_OAUTH_DEVICE",
                    redirectUri: "https://sub-etha.example/",
                    metadata: {
                        authorization_endpoint: "https://issuer.example/authorize",
                        code_challenge_methods_supported: ["S256"],
                        grant_types_supported: ["authorization_code", "refresh_token"],
                        issuer: "https://issuer.example/",
                        registration_endpoint: "https://issuer.example/register",
                        response_modes_supported: ["query", "fragment"],
                        response_types_supported: ["code"],
                        revocation_endpoint: "https://issuer.example/revoke",
                        token_endpoint: "https://issuer.example/token",
                    },
                },
                refreshToken: "queued-refresh-old",
                userId: "@queued:matrix.example",
            }),
        };
        const rotated: PersistedMatrixSession = {
            ...original,
            accessToken: "queued-access-new",
            refreshToken: "queued-refresh-new",
        };
        const lease = await createLockedSession(original, generateRecoveryKey());
        const originalEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        let pauseNextEncryption = true;

        t.mock.method(
            crypto.subtle,
            "encrypt",
            async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
                if (pauseNextEncryption) {
                    pauseNextEncryption = false;
                    reportEncryptionStarted();
                    await encryptionGate;
                }

                return originalEncrypt(...args);
            },
        );

        const revoked: string[] = [];

        t.mock.method(
            OAuth2.prototype,
            "revokeToken",
            async (token: string, type?: "access_token" | "refresh_token") => {
                revoked.push(`${type}-${token}`);
            },
        );

        const reseal = lease.reseal(rotated, "token-refresh");

        await encryptionStarted;
        const service = new MatrixService(lease);
        const logout = service.logout();

        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(revoked, []);
        assert.equal((await inspectSession()).kind, "locked");

        releaseEncryption();
        await reseal;
        const result = await logout;

        assert.deepEqual(result, { remoteSessionEnded: true });
        assert.deepEqual(revoked, [
            "refresh_token-queued-refresh-new",
            "access_token-queued-access-new",
        ]);
        assert.equal((await inspectSession()).kind, "empty");
    } finally {
        releaseEncryption();

        if (indexedDbDescriptor) {
            Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "indexedDB");
        }

        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    }
});

test("a response after the refresh deadline is revoked but keeps logout unconfirmed", async (t) => {
    const session: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        accessToken: "access-old",
        refreshToken: "refresh-old",
        oauth: {
            clientId: "client-id",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    let releaseRefresh: () => void = () => undefined;
    let reportRefreshStarted: () => void = () => undefined;
    const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
        reportRefreshStarted = resolve;
    });
    const cleanup: SessionCleanupDescriptor = {
        kind: "cleanup",
        recordId: "refresh-timeout-record",
        revision: 2,
        scope: "exact",
        cryptoDatabasePrefix: "refresh-timeout-prefix",
    };
    const order: string[] = [];
    let resealCalls = 0;
    const lease = {
        session,
        recordId: "refresh-timeout-record",
        revision: 1,
        cryptoDatabasePrefix: "refresh-timeout-prefix",
        reseal: async () => {
            resealCalls += 1;
        },
        dispose: () => undefined,
    };
    const service = new MatrixService(lease as never);

    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => {
        reportRefreshStarted();
        await refreshGate;

        return {
            access_token: "access-late",
            refresh_token: "refresh-late",
            expires_in: 60,
        };
    });
    t.mock.method(
        OAuth2.prototype,
        "revokeToken",
        async (token: string, type?: "access_token" | "refresh_token") => {
            order.push(`revoke-${type}-${token}`);
        },
    );

    const internals = service as unknown as {
        remoteRefreshTimeoutMs: number;
        refreshTokens: (refreshToken: string) => Promise<unknown>;
        deleteCurrentSession: () => Promise<SessionDeletionResult>;
        cleanupCurrentSessionDatabases: () => Promise<void>;
        completeCurrentSessionCleanup: () => Promise<void>;
    };

    internals.remoteRefreshTimeoutMs = 1;

    internals.deleteCurrentSession = async () => {
        order.push("record-tombstone");

        return { cleanup, session };
    };

    internals.cleanupCurrentSessionDatabases = async () => {
        order.push("database-cleanup");
    };

    internals.completeCurrentSessionCleanup = async () => {
        order.push("cleanup-complete");
    };

    const refresh = internals.refreshTokens("refresh-old");
    const refreshResult = refresh.catch((error: unknown) => error);

    await refreshStarted;
    const refreshError = await refreshResult;
    const logoutResult = await service.logout();

    assert.deepEqual(logoutResult, { remoteSessionEnded: false });
    assert.match((refreshError as Error).message, /refresh timed out/i);
    assert.equal(resealCalls, 0);
    assert.deepEqual(order, [
        "record-tombstone",
        "revoke-refresh_token-refresh-old",
        "revoke-access_token-access-old",
        "database-cleanup",
        "cleanup-complete",
    ]);

    releaseRefresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(resealCalls, 0);
    assert.deepEqual(order, [
        "record-tombstone",
        "revoke-refresh_token-refresh-old",
        "revoke-access_token-access-old",
        "database-cleanup",
        "cleanup-complete",
        "revoke-refresh_token-refresh-late",
        "revoke-access_token-access-late",
    ]);
});

test("logout persists crash-safe intent before stalled refresh and remote work", async (t) => {
    const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const heldLocks = new Set<string>();
    let releaseRefresh = (): void => undefined;
    let reportRefreshStarted = (): void => undefined;
    let releaseRemote = (): void => undefined;
    let reportRemoteStarted = (): void => undefined;
    const refreshGate = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
    });
    const refreshStarted = new Promise<void>((resolve) => {
        reportRefreshStarted = resolve;
    });
    const remoteGate = new Promise<void>((resolve) => {
        releaseRemote = resolve;
    });
    const remoteStarted = new Promise<void>((resolve) => {
        reportRemoteStarted = resolve;
    });
    let logout: ReturnType<MatrixService["logout"]> | null = null;

    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: new IDBFactory(),
        writable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async <T>(
                    name: string,
                    options: LockOptions,
                    callback: (lock: Lock | null) => T | PromiseLike<T>,
                ): Promise<T> => {
                    if (options.ifAvailable && heldLocks.has(name)) {
                        return callback(null);
                    }

                    heldLocks.add(name);

                    try {
                        return await callback({ name } as Lock);
                    } finally {
                        heldLocks.delete(name);
                    }
                },
            },
        },
    });

    try {
        const persisted = createSession({
            accessToken: "logout-crash-access",
            authKind: "oauth",
            baseUrl: "https://matrix.example",
            deviceId: "LOGOUT_CRASH_DEVICE",
            expiresAt: Date.now() + 60_000,
            oauth: {
                clientId: "logout-crash-client",
                deviceId: "LOGOUT_CRASH_OAUTH_DEVICE",
                redirectUri: "https://sub-etha.example/",
                metadata: {
                    authorization_endpoint: "https://issuer.example/authorize",
                    code_challenge_methods_supported: ["S256"],
                    grant_types_supported: ["authorization_code", "refresh_token"],
                    issuer: "https://issuer.example/",
                    registration_endpoint: "https://issuer.example/register",
                    response_modes_supported: ["query", "fragment"],
                    response_types_supported: ["code"],
                    revocation_endpoint: "https://issuer.example/revoke",
                    token_endpoint: "https://issuer.example/token",
                },
            },
            refreshToken: "logout-crash-refresh",
            userId: "@logout-crash:matrix.example",
        });
        const lease = await createLockedSession(persisted, generateRecoveryKey());
        const service = new MatrixService(lease);

        t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => {
            reportRefreshStarted();
            await refreshGate;

            return {
                access_token: "logout-crash-access-late",
                refresh_token: "logout-crash-refresh-late",
                expires_in: 60,
            };
        });

        const internals = service as unknown as {
            refreshTokens: (refreshToken: string) => Promise<unknown>;
            endRemoteSession: (session: Readonly<PersistedMatrixSession>) => Promise<boolean>;
            remoteLogoutTimeoutMs: number;
        };

        internals.remoteLogoutTimeoutMs = 5_000;

        internals.endRemoteSession = async (candidate) => {
            if (candidate.accessToken === "logout-crash-access-late") {
                return true;
            }

            reportRemoteStarted();
            await remoteGate;

            return true;
        };

        const refreshResult = internals
            .refreshTokens("logout-crash-refresh")
            .catch((error: unknown) => error);

        await refreshStarted;
        logout = service.logout();
        await remoteStarted;

        const persistedIntent = await inspectSession();

        assert.equal(persistedIntent.kind, "cleanup");
        assert.deepEqual(await inspectSession(), persistedIntent);

        releaseRefresh();
        const refreshError = await refreshResult;

        assert.match((refreshError as Error).message, /locked during token refresh/i);
        assert.deepEqual(await inspectSession(), persistedIntent);

        releaseRemote();
        await logout;
        logout = null;
        assert.equal((await inspectSession()).kind, "empty");
    } finally {
        releaseRefresh();
        releaseRemote();
        await logout?.catch(() => undefined);

        if (indexedDbDescriptor) {
            Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "indexedDB");
        }

        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    }
});

test("startup passes the lease's exact Rust prefix and key and releases ownership last", async (t) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const order: string[] = [];
    const startupOrder: string[] = [];
    const expectedKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const keyText = Buffer.from(expectedKey).toString("base64url");
    let capturedPrefix: string | undefined;
    let capturedKey: Uint8Array | undefined;
    const capturedLockNames: string[] = [];
    let session: PersistedMatrixSession = { ...SESSION, cryptoStorageKey: keyText };
    const lease = {
        get session() {
            return session;
        },
        recordId: "opaque-record",
        revision: 1,
        cryptoDatabasePrefix: "preserved-rust-prefix",
        assertCurrent: async () => {
            startupOrder.push("freshness");
        },
        reseal: async (nextSession: PersistedMatrixSession) => {
            session = nextSession;
        },
        dispose: () => order.push("lease-dispose"),
    };

    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (
                    name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => Promise<void>,
                ) => {
                    capturedLockNames.push(name);
                    startupOrder.push(name);
                    await callback({} as Lock);
                    order.push(`${name}-release`);
                },
            },
            onLine: true,
        },
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            cancelAnimationFrame: () => undefined,
        },
    });

    t.mock.method(
        MatrixClient.prototype,
        "initRustCrypto",
        async (options: Parameters<MatrixClient["initRustCrypto"]>[0]) => {
            assert.ok(options);
            startupOrder.push("rust");
            capturedPrefix = options.cryptoDatabasePrefix;
            capturedKey = options.storageKey ? Uint8Array.from(options.storageKey) : undefined;
        },
    );
    t.mock.method(MatrixClient.prototype, "startClient", () => undefined);
    t.mock.method(MatrixClient.prototype, "stopClient", () => {
        order.push("client-stop");
    });
    t.mock.method(MatrixClient.prototype, "getProfileInfo", async () => ({}));

    try {
        const service = new MatrixService(lease as never);

        await service.start();
        assert.deepEqual(capturedLockNames, [
            "sub-etha-session-vault-v1",
            "sub-etha-matrix-_arthur_matrix_example-DEVICE",
        ]);
        assert.deepEqual(startupOrder, [
            "sub-etha-session-vault-v1",
            "sub-etha-matrix-_arthur_matrix_example-DEVICE",
            "freshness",
            "rust",
        ]);
        assert.equal(capturedPrefix, "preserved-rust-prefix");
        assert.deepEqual(capturedKey, expectedKey);
        assert.equal((service as unknown as { store: unknown }).store instanceof MemoryStore, true);

        service.stop();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(order, [
            "client-stop",
            "lease-dispose",
            "sub-etha-matrix-_arthur_matrix_example-DEVICE-release",
            "sub-etha-session-vault-v1-release",
        ]);
    } finally {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }

        if (windowDescriptor) {
            Object.defineProperty(globalThis, "window", windowDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }
    }
});

test("stop during Rust initialization fences startup and holds ownership until Rust closes", async (t) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const order: string[] = [];
    const keyText = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        "base64url",
    );
    let releaseInitialization: () => void = () => undefined;
    let reportInitializationStarted: () => void = () => undefined;
    const initializationGate = new Promise<void>((resolve) => {
        releaseInitialization = resolve;
    });
    const initializationStarted = new Promise<void>((resolve) => {
        reportInitializationStarted = resolve;
    });
    let disposed = false;
    const capturedRustStorage = {
        key: null as Uint8Array<ArrayBufferLike> | null,
    };
    const lease = {
        session: { ...SESSION, cryptoStorageKey: keyText },
        recordId: "startup-stop-record",
        revision: 1,
        cryptoDatabasePrefix: "startup-stop-prefix",
        assertCurrent: async () => undefined,
        reseal: async () => undefined,
        dispose: () => {
            if (!disposed) {
                disposed = true;
                order.push("lease-dispose");
            }
        },
    };

    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (
                    name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => Promise<void>,
                ) => {
                    await callback({} as Lock);
                    order.push(`${name}-release`);
                },
            },
            onLine: true,
        },
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            cancelAnimationFrame: () => undefined,
        },
    });

    const initRustCrypto = t.mock.method(
        MatrixClient.prototype,
        "initRustCrypto",
        async (options: Parameters<MatrixClient["initRustCrypto"]>[0]) => {
            capturedRustStorage.key = options?.storageKey ?? null;
            order.push("rust-init-start");
            reportInitializationStarted();
            await initializationGate;
            order.push("rust-init-finish");
        },
    );
    const startClient = t.mock.method(MatrixClient.prototype, "startClient", () => undefined);

    t.mock.method(MatrixClient.prototype, "stopClient", () => {
        order.push("client-stop");
    });

    try {
        const service = new MatrixService(lease as never);
        const start = service.start();

        await initializationStarted;
        const exactDecodedKey = capturedRustStorage.key;

        if (!exactDecodedKey) {
            throw new Error("Rust initialization did not receive the decoded storage key.");
        }

        assert.equal(
            exactDecodedKey.some((byte) => byte !== 0),
            true,
        );
        service.stop();
        assert.deepEqual(order, ["rust-init-start", "client-stop"]);
        assert.equal(
            exactDecodedKey.every((byte) => byte === 0),
            true,
        );
        assert.equal(disposed, false);
        assert.equal(startClient.mock.callCount(), 0);
        assert.deepEqual(service.getSnapshot(), {
            connection: "idle",
            rooms: [],
            activeRoomId: null,
            timeline: [],
            timelineStartIndex: 1_000_000,
            typingNames: [],
            loadingHistory: false,
            hasMoreHistory: false,
            error: null,
            userId: "",
            displayName: "",
            avatarMxcUrl: null,
            deviceId: "",
            verification: null,
        });

        releaseInitialization();
        await assert.rejects(start, /startup was cancelled/i);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(initRustCrypto.mock.callCount(), 1);
        assert.equal(startClient.mock.callCount(), 0);
        assert.deepEqual(order, [
            "rust-init-start",
            "client-stop",
            "rust-init-finish",
            "lease-dispose",
            "sub-etha-matrix-_arthur_matrix_example-DEVICE-release",
            "sub-etha-session-vault-v1-release",
        ]);
    } finally {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }

        if (windowDescriptor) {
            Object.defineProperty(globalThis, "window", windowDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }
    }
});

test("logout waits for an async startClient to stop again before cleanup and lock release", async (t) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const keyText = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        "base64url",
    );
    const order: string[] = [];
    let releaseClientStart: () => void = () => undefined;
    let reportClientStart: () => void = () => undefined;
    const clientStartGate = new Promise<void>((resolve) => {
        releaseClientStart = resolve;
    });
    const clientStartEntered = new Promise<void>((resolve) => {
        reportClientStart = resolve;
    });
    let disposeCalls = 0;
    const lease = {
        session: { ...SESSION, cryptoStorageKey: keyText },
        recordId: "async-start-logout-record",
        revision: 1,
        cryptoDatabasePrefix: "async-start-logout-prefix",
        assertCurrent: async () => undefined,
        reseal: async () => undefined,
        dispose: () => {
            disposeCalls += 1;
            order.push("lease-dispose");
        },
    };
    const cleanup: SessionCleanupDescriptor = {
        kind: "cleanup",
        recordId: "async-start-logout-record",
        revision: 2,
        scope: "exact",
        cryptoDatabasePrefix: "async-start-logout-prefix",
    };

    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (
                    name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => Promise<void>,
                ) => {
                    await callback({ name } as Lock);
                    order.push(`${name}-release`);
                },
            },
            onLine: true,
        },
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            cancelAnimationFrame: () => undefined,
        },
    });

    t.mock.method(MatrixClient.prototype, "initRustCrypto", async () => undefined);
    t.mock.method(MatrixClient.prototype, "startClient", async function (this: MatrixClient) {
        order.push("start-client-enter");
        reportClientStart();
        await clientStartGate;
        order.push("start-client-resume");
        this.emit(ClientEvent.Sync, SyncState.Syncing, null);
    });
    t.mock.method(MatrixClient.prototype, "stopClient", () => {
        order.push("client-stop");
    });
    t.mock.method(MatrixClient.prototype, "getProfileInfo", async () => ({}));

    let logout: ReturnType<MatrixService["logout"]> | null = null;

    try {
        const service = new MatrixService(lease as never);
        const startResult = service.start().catch((error: unknown) => error);

        await clientStartEntered;
        const internals = service as unknown as {
            deleteCurrentSession: () => Promise<SessionDeletionResult>;
            cleanupCurrentSessionDatabases: () => Promise<void>;
            completeCurrentSessionCleanup: () => Promise<void>;
            endRemoteSession: () => Promise<boolean>;
        };

        internals.deleteCurrentSession = async () => {
            order.push("record-tombstone");

            return { cleanup, session: lease.session };
        };

        internals.cleanupCurrentSessionDatabases = async () => {
            order.push("database-cleanup");
        };

        internals.completeCurrentSessionCleanup = async () => {
            order.push("cleanup-complete");
        };

        internals.endRemoteSession = async () => true;

        logout = service.logout();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(order.includes("record-tombstone"), true);
        assert.equal(order.includes("database-cleanup"), false);
        assert.equal(
            order.some((entry) => entry.endsWith("-release")),
            false,
        );
        assert.equal(disposeCalls, 0);
        assert.equal(service.getSnapshot().connection, "idle");

        releaseClientStart();
        const startError = await startResult;
        const logoutResult = await logout;

        logout = null;
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.match((startError as Error).message, /startup was cancelled/i);
        assert.deepEqual(logoutResult, { remoteSessionEnded: true });
        assert.equal(service.getSnapshot().connection, "idle");
        assert.equal(disposeCalls, 1);
        assert.equal(order.filter((entry) => entry === "client-stop").length >= 2, true);
        assert.equal(
            order.indexOf("start-client-resume") < order.indexOf("database-cleanup"),
            true,
        );
        assert.equal(
            order.indexOf("database-cleanup") <
                order.indexOf("sub-etha-matrix-_arthur_matrix_example-DEVICE-release"),
            true,
        );
    } finally {
        releaseClientStart();
        await logout?.catch(() => undefined);

        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }

        if (windowDescriptor) {
            Object.defineProperty(globalThis, "window", windowDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }
    }
});

test("stop during a paused refresh reseal retains both locks until serialization settles", async (t) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const heldLocks = new Set<string>();
    const keyText = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        "base64url",
    );
    let session: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        cryptoStorageKey: keyText,
        refreshToken: "stop-reseal-refresh-old",
        oauth: {
            clientId: "stop-reseal-client",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    let releaseReseal: () => void = () => undefined;
    let reportResealStarted: () => void = () => undefined;
    const resealGate = new Promise<void>((resolve) => {
        releaseReseal = resolve;
    });
    const resealStarted = new Promise<void>((resolve) => {
        reportResealStarted = resolve;
    });
    let originalDisposeCalls = 0;
    let blockedDisposeCalls = 0;
    let nextDisposeCalls = 0;
    const revoked: string[] = [];
    const originalLease = {
        get session() {
            return session;
        },
        recordId: "stop-reseal-record",
        revision: 1,
        cryptoDatabasePrefix: "stop-reseal-prefix",
        assertCurrent: async () => undefined,
        reseal: async (nextSession: PersistedMatrixSession) => {
            reportResealStarted();
            await resealGate;
            session = nextSession;
        },
        dispose: () => {
            originalDisposeCalls += 1;
        },
    };
    const competingLease = (dispose: () => void) => ({
        get session() {
            return session;
        },
        recordId: "stop-reseal-record",
        revision: 2,
        cryptoDatabasePrefix: "stop-reseal-prefix",
        assertCurrent: async () => undefined,
        reseal: async () => undefined,
        dispose,
    });

    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async <T>(
                    name: string,
                    options: LockOptions,
                    callback: (lock: Lock | null) => T | PromiseLike<T>,
                ): Promise<T> => {
                    if (options.ifAvailable && heldLocks.has(name)) {
                        return callback(null);
                    }

                    heldLocks.add(name);

                    try {
                        return await callback({ name } as Lock);
                    } finally {
                        heldLocks.delete(name);
                    }
                },
            },
            onLine: true,
        },
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            cancelAnimationFrame: () => undefined,
        },
    });

    t.mock.method(MatrixClient.prototype, "initRustCrypto", async () => undefined);
    t.mock.method(MatrixClient.prototype, "startClient", () => undefined);
    t.mock.method(MatrixClient.prototype, "stopClient", () => undefined);
    t.mock.method(MatrixClient.prototype, "getProfileInfo", async () => ({}));
    t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => ({
        access_token: "stop-reseal-access-new",
        refresh_token: "stop-reseal-refresh-new",
        expires_in: 60,
    }));
    t.mock.method(
        OAuth2.prototype,
        "revokeToken",
        async (token: string, type?: "access_token" | "refresh_token") => {
            revoked.push(`${type}-${token}`);
        },
    );

    let originalService: MatrixService | undefined;
    let nextService: MatrixService | undefined;

    try {
        originalService = new MatrixService(originalLease as never);
        await originalService.start();
        assert.deepEqual(
            [...heldLocks].sort(),
            ["sub-etha-matrix-_arthur_matrix_example-DEVICE", "sub-etha-session-vault-v1"].sort(),
        );

        const refresh = (
            originalService as unknown as {
                refreshTokens: (refreshToken: string) => Promise<unknown>;
            }
        ).refreshTokens("stop-reseal-refresh-old");
        const refreshResult = refresh.catch((error: unknown) => error);

        await resealStarted;
        originalService.stop();
        assert.equal(originalDisposeCalls, 0);
        assert.equal(heldLocks.size, 2);

        const blockedService = new MatrixService(
            competingLease(() => {
                blockedDisposeCalls += 1;
            }) as never,
        );

        await assert.rejects(blockedService.start(), MatrixAlreadyOpenError);
        assert.equal(blockedDisposeCalls, 1);
        assert.equal(heldLocks.size, 2);

        releaseReseal();
        const refreshError = await refreshResult;

        assert.match((refreshError as Error).message, /locked during token refresh/i);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(session.accessToken, "stop-reseal-access-new");
        assert.deepEqual(revoked, []);
        assert.equal(originalDisposeCalls, 1);
        assert.equal(heldLocks.size, 0);

        nextService = new MatrixService(
            competingLease(() => {
                nextDisposeCalls += 1;
            }) as never,
        );
        await nextService.start();
        assert.equal(heldLocks.size, 2);
        nextService.stop();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(nextDisposeCalls, 1);
        assert.equal(heldLocks.size, 0);
    } finally {
        releaseReseal();
        originalService?.stop();
        nextService?.stop();

        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }

        if (windowDescriptor) {
            Object.defineProperty(globalThis, "window", windowDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }
    }
});

test("concurrent startup calls share one lock and one Rust initialization", async (t) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const keyText = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        "base64url",
    );
    let lockRequests = 0;
    let releaseInitialization: () => void = () => undefined;
    let reportInitializationStarted: () => void = () => undefined;
    const initializationGate = new Promise<void>((resolve) => {
        releaseInitialization = resolve;
    });
    const initializationStarted = new Promise<void>((resolve) => {
        reportInitializationStarted = resolve;
    });
    const lease = {
        session: { ...SESSION, cryptoStorageKey: keyText },
        recordId: "concurrent-start-record",
        revision: 1,
        cryptoDatabasePrefix: "concurrent-start-prefix",
        assertCurrent: async () => undefined,
        reseal: async () => undefined,
        dispose: () => undefined,
    };

    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (
                    _name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => Promise<void>,
                ) => {
                    lockRequests += 1;
                    await callback({} as Lock);
                },
            },
            onLine: true,
        },
    });
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: {
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            cancelAnimationFrame: () => undefined,
        },
    });

    const initRustCrypto = t.mock.method(MatrixClient.prototype, "initRustCrypto", async () => {
        reportInitializationStarted();
        await initializationGate;
    });
    const startClient = t.mock.method(MatrixClient.prototype, "startClient", () => undefined);

    t.mock.method(MatrixClient.prototype, "stopClient", () => undefined);
    t.mock.method(MatrixClient.prototype, "getProfileInfo", async () => ({}));

    try {
        const service = new MatrixService(lease as never);
        const first = service.start();
        const second = service.start();

        assert.equal(first, second);
        await initializationStarted;
        assert.equal(lockRequests, 2);
        assert.equal(initRustCrypto.mock.callCount(), 1);
        releaseInitialization();
        await Promise.all([first, second]);
        assert.equal(startClient.mock.callCount(), 1);

        await service.start();
        assert.equal(lockRequests, 2);
        assert.equal(initRustCrypto.mock.callCount(), 1);
        service.stop();
    } finally {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }

        if (windowDescriptor) {
            Object.defineProperty(globalThis, "window", windowDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "window");
        }
    }
});

test("an unavailable account lock releases the already-held vault lock", async (t) => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const requestedLocks: string[] = [];
    const order: string[] = [];
    let freshnessChecks = 0;
    let disposeCalls = 0;
    const service = new MatrixService({
        session: SESSION,
        recordId: "partial-lock-record",
        revision: 1,
        cryptoDatabasePrefix: "partial-lock-prefix",
        assertCurrent: async () => {
            freshnessChecks += 1;
        },
        reseal: async () => undefined,
        dispose: () => {
            disposeCalls += 1;
            order.push("lease-dispose");
        },
    } as never);

    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (
                    name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => Promise<void>,
                ) => {
                    requestedLocks.push(name);

                    if (name.startsWith("sub-etha-matrix-")) {
                        await callback(null);

                        return;
                    }

                    await callback({ name } as Lock);
                    order.push("vault-lock-release");
                },
            },
        },
    });

    const initRustCrypto = t.mock.method(MatrixClient.prototype, "initRustCrypto");

    try {
        await assert.rejects(service.start(), MatrixAlreadyOpenError);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(requestedLocks, [
            "sub-etha-session-vault-v1",
            "sub-etha-matrix-_arthur_matrix_example-DEVICE",
        ]);
        assert.equal(freshnessChecks, 0);
        assert.equal(initRustCrypto.mock.callCount(), 0);
        assert.equal(disposeCalls, 1);
        assert.deepEqual(order, ["lease-dispose", "vault-lock-release"]);
    } finally {
        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    }
});

test("a tombstoned stale lease fails freshness under both locks before Rust starts", async (t) => {
    const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const order: string[] = [];
    const keyText = Buffer.from(Uint8Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        "base64url",
    );

    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: new IDBFactory(),
        writable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async (
                    name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => Promise<void>,
                ) => {
                    const result = await callback({ name } as Lock);

                    order.push(`${name}-release`);

                    return result;
                },
            },
        },
    });

    const initRustCrypto = t.mock.method(MatrixClient.prototype, "initRustCrypto");

    try {
        const recoveryKey = generateRecoveryKey();
        const current = await createLockedSession(
            { ...SESSION, cryptoStorageKey: keyText },
            recoveryKey,
        );
        const inspection = await inspectSession();

        assert.equal(inspection.kind, "locked");

        if (inspection.kind !== "locked") {
            throw new Error("Expected a locked session.");
        }

        const stale = await unlockSession(inspection, { kind: "recovery-key", recoveryKey });

        await deleteSessionRecord(current);
        order.length = 0;
        const service = new MatrixService(stale);

        await assert.rejects(service.start(), /no longer current/i);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(initRustCrypto.mock.callCount(), 0);
        assert.deepEqual(order, [
            "sub-etha-matrix-_arthur_matrix_example-DEVICE-release",
            "sub-etha-session-vault-v1-release",
        ]);
    } finally {
        if (indexedDbDescriptor) {
            Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "indexedDB");
        }

        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    }
});

test("logout tombstones before exact database cleanup and releases ownership last", async () => {
    const order: string[] = [];
    let disposed = false;
    const cleanup: SessionCleanupDescriptor = {
        kind: "cleanup",
        recordId: "logout-record",
        revision: 8,
        scope: "exact",
        cryptoDatabasePrefix: "logout-rust-prefix",
        legacySyncDatabase: "logout-sync-database",
    };
    const lease = {
        session: SESSION,
        recordId: "logout-record",
        revision: 7,
        cryptoDatabasePrefix: "logout-rust-prefix",
        reseal: async () => undefined,
        dispose: () => {
            if (!disposed) {
                disposed = true;
                order.push("lease-dispose");
            }
        },
    };
    const service = new MatrixService(lease as never);
    const internals = service as unknown as {
        client: {
            logout: () => Promise<void>;
            off: (...args: unknown[]) => void;
            stopClient: () => void;
        } | null;
        releaseLock: (() => void) | null;
        releaseVaultLock: (() => void) | null;
        deleteCurrentSession: (candidate: typeof lease) => Promise<SessionDeletionResult>;
        cleanupCurrentSessionDatabases: (candidate: SessionCleanupDescriptor) => Promise<void>;
        completeCurrentSessionCleanup: (candidate: SessionCleanupDescriptor) => Promise<void>;
        endRemoteSession: (candidate: Readonly<PersistedMatrixSession>) => Promise<boolean>;
    };

    internals.client = {
        logout: async () => {
            order.push("remote-logout");
        },
        off: () => undefined,
        stopClient: () => {
            order.push("client-stop");
        },
    };

    internals.releaseLock = () => order.push("lock-release");
    internals.releaseVaultLock = () => order.push("vault-lock-release");

    internals.endRemoteSession = async (candidate) => {
        assert.equal(candidate.accessToken, SESSION.accessToken);
        order.push("remote-logout");

        return true;
    };

    internals.deleteCurrentSession = async (candidate) => {
        assert.equal(candidate, lease);
        assert.equal(candidate.recordId, "logout-record");
        assert.equal(candidate.revision, 7);
        assert.equal(disposed, false);
        order.push("record-tombstone");
        candidate.dispose();

        return { cleanup, session: SESSION };
    };

    internals.cleanupCurrentSessionDatabases = async (candidate) => {
        assert.equal(candidate, cleanup);
        assert.equal(candidate.cryptoDatabasePrefix, "logout-rust-prefix");
        assert.equal(candidate.legacySyncDatabase, "logout-sync-database");
        order.push("database-cleanup");
    };

    internals.completeCurrentSessionCleanup = async (candidate) => {
        assert.equal(candidate, cleanup);
        order.push("cleanup-complete");
    };

    const result = await service.logout();

    assert.deepEqual(result, { remoteSessionEnded: true });
    assert.deepEqual(order, [
        "client-stop",
        "record-tombstone",
        "lease-dispose",
        "remote-logout",
        "database-cleanup",
        "cleanup-complete",
        "lock-release",
        "vault-lock-release",
    ]);
});

test("pending non-OAuth revocation uses a memory-only Matrix client", async (t) => {
    let logoutCalls = 0;
    let usedMemoryStore = false;

    t.mock.method(MatrixClient.prototype, "logout", async function (this: MatrixClient) {
        logoutCalls += 1;
        usedMemoryStore = this.store instanceof MemoryStore;
    });

    const result = await revokePendingMatrixSession(SESSION);

    assert.deepEqual(result, { confirmed: true });
    assert.equal(logoutCalls, 1);
    assert.equal(usedMemoryStore, true);
});

test("OAuth logout revokes both tokens independently before mandatory local cleanup", async (t) => {
    const order: string[] = [];
    let matrixLogoutCalls = 0;
    const oauthSession: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        oauth: {
            clientId: "oauth-client",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    const lease = {
        session: oauthSession,
        recordId: "oauth-logout-record",
        revision: 11,
        cryptoDatabasePrefix: "oauth-logout-prefix",
        reseal: async () => undefined,
        dispose: () => {
            order.push("lease-dispose");
        },
    };
    const service = new MatrixService(lease as never);
    const cleanup: SessionCleanupDescriptor = {
        kind: "cleanup",
        recordId: "oauth-logout-record",
        revision: 12,
        scope: "exact",
        cryptoDatabasePrefix: "oauth-logout-prefix",
    };
    const internals = service as unknown as {
        client: {
            logout: () => Promise<void>;
            off: (...args: unknown[]) => void;
            stopClient: () => void;
        } | null;
        deleteCurrentSession: () => Promise<SessionDeletionResult>;
        cleanupCurrentSessionDatabases: () => Promise<void>;
        completeCurrentSessionCleanup: () => Promise<void>;
    };

    t.mock.method(
        OAuth2.prototype,
        "revokeToken",
        (token: string, type?: "access_token" | "refresh_token") => {
            order.push(`revoke-${type}-${token}`);

            if (type === "refresh_token") {
                throw new Error("refresh revocation failed");
            }

            return Promise.resolve();
        },
    );

    internals.client = {
        logout: async () => {
            matrixLogoutCalls += 1;
        },
        off: () => undefined,
        stopClient: () => {
            order.push("client-stop");
        },
    };

    internals.deleteCurrentSession = async () => {
        order.push("record-tombstone");

        return { cleanup, session: oauthSession };
    };

    internals.cleanupCurrentSessionDatabases = async () => {
        order.push("database-cleanup");
    };

    internals.completeCurrentSessionCleanup = async () => {
        order.push("cleanup-complete");
    };

    const result = await service.logout();

    assert.deepEqual(result, { remoteSessionEnded: false });
    assert.equal(matrixLogoutCalls, 0);
    assert.deepEqual(order, [
        "client-stop",
        "record-tombstone",
        "revoke-refresh_token-oauth-refresh",
        "revoke-access_token-oauth-access",
        "database-cleanup",
        "cleanup-complete",
        "lease-dispose",
    ]);
});

test("a stalled remote logout is time-bounded and cannot block local cleanup", async () => {
    const oauthSession: PersistedMatrixSession = {
        ...SESSION,
        authKind: "oauth",
        oauth: {
            clientId: "oauth-client",
            deviceId: "DEVICE",
            redirectUri: "https://sub-etha.example/",
            metadata: {} as never,
        },
    };
    const cleanup: SessionCleanupDescriptor = {
        kind: "cleanup",
        recordId: "timeout-logout-record",
        revision: 2,
        scope: "exact",
        cryptoDatabasePrefix: "timeout-logout-prefix",
    };
    const order: string[] = [];
    const lease = {
        session: oauthSession,
        recordId: "timeout-logout-record",
        revision: 1,
        cryptoDatabasePrefix: "timeout-logout-prefix",
        reseal: async () => undefined,
        dispose: () => order.push("lease-dispose"),
    };
    const service = new MatrixService(lease as never);
    const internals = service as unknown as {
        remoteLogoutTimeoutMs: number;
        endRemoteSession: () => Promise<boolean>;
        deleteCurrentSession: () => Promise<SessionDeletionResult>;
        cleanupCurrentSessionDatabases: () => Promise<void>;
        completeCurrentSessionCleanup: () => Promise<void>;
    };

    internals.remoteLogoutTimeoutMs = 1;
    internals.endRemoteSession = () => new Promise<boolean>(() => undefined);

    internals.deleteCurrentSession = async () => {
        order.push("record-tombstone");

        return { cleanup, session: oauthSession };
    };

    internals.cleanupCurrentSessionDatabases = async () => {
        order.push("database-cleanup");
    };

    internals.completeCurrentSessionCleanup = async () => {
        order.push("cleanup-complete");
    };

    const result = await service.logout();

    assert.deepEqual(result, { remoteSessionEnded: false });
    assert.deepEqual(order, [
        "record-tombstone",
        "database-cleanup",
        "cleanup-complete",
        "lease-dispose",
    ]);
});

test("logout aborts active attachment and avatar uploads before either can publish", async () => {
    const service = createService();
    const cleanup: SessionCleanupDescriptor = {
        kind: "cleanup",
        recordId: "upload-logout-record",
        revision: 2,
        scope: "exact",
        cryptoDatabasePrefix: "upload-logout-prefix",
    };
    const uploadControllers: AbortController[] = [];
    let reportUploadsStarted: () => void = () => undefined;
    const uploadsStarted = new Promise<void>((resolve) => {
        reportUploadsStarted = resolve;
    });
    let roomSendCalls = 0;
    let avatarMutationCalls = 0;
    const client = {
        getRoom: () => ({
            hasEncryptionStateEvent: () => false,
        }),
        uploadContent: (
            _body: Blob,
            options?: { abortController?: AbortController },
        ): Promise<{ content_uri: string }> => {
            const controller = options?.abortController;

            if (!controller) {
                throw new Error("Expected an explicit upload AbortController.");
            }

            uploadControllers.push(controller);

            if (uploadControllers.length === 2) {
                reportUploadsStarted();
            }

            return new Promise((_resolve, reject) => {
                controller.signal.addEventListener(
                    "abort",
                    () => reject(new DOMException("Aborted", "AbortError")),
                    { once: true },
                );
            });
        },
        sendMessage: async () => {
            roomSendCalls += 1;
        },
        setAvatarUrl: async () => {
            avatarMutationCalls += 1;
        },
        off: () => undefined,
        stopClient: () => undefined,
    } as unknown as MatrixClient;
    const internals = service as unknown as {
        client: MatrixClient | null;
        snapshot: MatrixSnapshot;
        deleteCurrentSession: () => Promise<SessionDeletionResult>;
        cleanupCurrentSessionDatabases: () => Promise<void>;
        completeCurrentSessionCleanup: () => Promise<void>;
        endRemoteSession: () => Promise<boolean>;
    };

    internals.client = client;
    internals.snapshot = {
        ...service.getSnapshot(),
        activeRoomId: "!uploads:matrix.example",
    };
    internals.deleteCurrentSession = async () => ({ cleanup, session: SESSION });
    internals.cleanupCurrentSessionDatabases = async () => undefined;
    internals.completeCurrentSessionCleanup = async () => undefined;
    internals.endRemoteSession = async () => true;

    const attachmentResult = service
        .sendFile(new File(["attachment"], "attachment.txt", { type: "text/plain" }))
        .catch((error: unknown) => error);
    const avatarResult = service
        .updateProfile("", new File(["avatar"], "avatar.txt", { type: "text/plain" }))
        .catch((error: unknown) => error);

    await uploadsStarted;
    const logoutResult = await service.logout();
    const [attachmentError, avatarError] = await Promise.all([attachmentResult, avatarResult]);

    assert.deepEqual(logoutResult, { remoteSessionEnded: true });
    assert.equal(uploadControllers.length, 2);
    assert.equal(
        uploadControllers.every((controller) => controller.signal.aborted),
        true,
    );
    assert.equal((attachmentError as Error).name, "AbortError");
    assert.equal((avatarError as Error).name, "AbortError");
    assert.equal(roomSendCalls, 0);
    assert.equal(avatarMutationCalls, 0);
});

test("setupRecovery zeroes the generated private key after bootstrap", async () => {
    const service = createService();
    const generatedPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const generated = {
        privateKey: generatedPrivateKey,
        encodedPrivateKey: "displayable-recovery-key" as string | undefined,
    };
    let bootstrapSawPrivateKey = false;
    const cryptoApi = {
        createRecoveryKeyFromPassphrase: async () => generated,
        bootstrapSecretStorage: async (options: {
            createSecretStorageKey: () => Promise<{
                privateKey: Uint8Array<ArrayBuffer>;
                encodedPrivateKey?: string;
            }>;
        }) => {
            const generated = await options.createSecretStorageKey();

            bootstrapSawPrivateKey = generated.privateKey.some((byte) => byte !== 0);
        },
    };
    const client = {
        getCrypto: () => cryptoApi,
        off: () => undefined,
        stopClient: () => undefined,
    } as unknown as MatrixClient;
    const internals = service as unknown as { client: MatrixClient | null };

    internals.client = client;
    const result = await service.setupRecovery();

    assert.equal(result, "displayable-recovery-key");
    assert.equal(bootstrapSawPrivateKey, true);
    assert.equal(
        generatedPrivateKey.every((byte) => byte === 0),
        true,
    );
    assert.equal(generated.privateKey.byteLength, 0);
    assert.equal(generated.encodedPrivateKey, undefined);
    assert.equal("encodedPrivateKey" in generated, false);
    service.stop();
});

test("pagehide zeroes generated recovery material during a paused bootstrap", async () => {
    const service = createService();
    const generatedPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const generated = {
        privateKey: generatedPrivateKey,
        encodedPrivateKey: "pagehide-recovery-key" as string | undefined,
    };
    let releaseBootstrap = (): void => undefined;
    let reportBootstrapStarted = (): void => undefined;
    const bootstrapGate = new Promise<void>((resolve) => {
        releaseBootstrap = resolve;
    });
    const bootstrapStarted = new Promise<void>((resolve) => {
        reportBootstrapStarted = resolve;
    });
    const cryptoApi = {
        createRecoveryKeyFromPassphrase: async () => generated,
        bootstrapSecretStorage: async (options: {
            createSecretStorageKey: () => Promise<{
                privateKey: Uint8Array<ArrayBuffer>;
                encodedPrivateKey?: string;
            }>;
        }) => {
            const bootstrapMaterial = await options.createSecretStorageKey();

            assert.equal(bootstrapMaterial, generated);
            reportBootstrapStarted();
            await bootstrapGate;
        },
    };
    const client = {
        getCrypto: () => cryptoApi,
        off: () => undefined,
        stopClient: () => undefined,
    } as unknown as MatrixClient;
    const internals = service as unknown as {
        client: MatrixClient | null;
        transientRecoverySetups: Set<unknown>;
    };

    internals.client = client;
    const setupResult = service.setupRecovery().catch((error: unknown) => error);

    await bootstrapStarted;
    const shutdown = service.shutdownForPageHide();

    assert.deepEqual(shutdown, { refreshInFlight: false });
    assert.equal(
        generatedPrivateKey.every((byte) => byte === 0),
        true,
    );
    assert.equal(generated.privateKey.byteLength, 0);
    assert.equal(generated.encodedPrivateKey, undefined);
    assert.equal("encodedPrivateKey" in generated, false);
    assert.equal(internals.transientRecoverySetups.size, 0);

    releaseBootstrap();
    const setupError = await setupResult;

    assert.match((setupError as Error).message, /session was locked/i);
    assert.equal(internals.transientRecoverySetups.size, 0);
});

test("unlockRecovery cannot restore a secret key after stop and zeroes the late buffer", async () => {
    const service = createService();
    const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const recoveryKey = encodeRecoveryKey(rawKey);

    assert.ok(recoveryKey);

    let releaseBackupLoad: () => void = () => undefined;
    let reportBackupLoad: () => void = () => undefined;
    const backupLoadGate = new Promise<void>((resolve) => {
        releaseBackupLoad = resolve;
    });
    const backupLoadStarted = new Promise<void>((resolve) => {
        reportBackupLoad = resolve;
    });
    let backupEnableCalls = 0;
    const cryptoApi = {
        getSecretStorageStatus: async () => ({
            defaultKeyId: "recovery-key-id",
            secretStorageKeyValidityMap: {},
        }),
        loadSessionBackupPrivateKeyFromSecretStorage: async () => {
            reportBackupLoad();
            await backupLoadGate;
        },
        checkKeyBackupAndEnable: async () => {
            backupEnableCalls += 1;
        },
    };
    const client = {
        getCrypto: () => cryptoApi,
        secretStorage: {
            getKey: async () => ["recovery-key-id", {}],
        },
        off: () => undefined,
        stopClient: () => undefined,
    } as unknown as MatrixClient;
    const internals = service as unknown as {
        client: MatrixClient | null;
        secretStorageKey: [string, Uint8Array<ArrayBuffer>] | null;
    };

    internals.client = client;
    const unlockResult = service.unlockRecovery(recoveryKey).catch((error: unknown) => error);

    await backupLoadStarted;
    const cachedKey = internals.secretStorageKey?.[1];

    assert.ok(cachedKey);
    assert.deepEqual(cachedKey, rawKey);
    service.stop();
    assert.equal(
        cachedKey.every((byte) => byte === 0),
        true,
    );
    assert.equal(internals.secretStorageKey, null);

    releaseBackupLoad();
    const unlockError = await unlockResult;

    assert.match((unlockError as Error).message, /session was locked/i);
    assert.equal(backupEnableCalls, 0);
});

test("a late secret-storage cache callback is rejected and zeroed", () => {
    const service = createService();
    const client = {
        off: () => undefined,
        stopClient: () => undefined,
    } as unknown as MatrixClient;
    const internals = service as unknown as {
        client: MatrixClient | null;
        lifecycleGeneration: number;
        secretStorageKey: [string, Uint8Array<ArrayBuffer>] | null;
        cacheSecretStorageKey: (
            client: MatrixClient,
            generation: number,
            keyId: string,
            key: Uint8Array<ArrayBuffer>,
        ) => void;
    };
    const original = Uint8Array.from([1, 2, 3, 4]);

    internals.client = client;
    const generation = internals.lifecycleGeneration;

    internals.cacheSecretStorageKey(client, generation, "current-key", original);
    const cachedKey = internals.secretStorageKey?.[1];

    assert.ok(cachedKey);
    assert.notEqual(cachedKey, original);
    assert.deepEqual(cachedKey, original);
    service.stop();
    assert.equal(
        cachedKey.every((byte) => byte === 0),
        true,
    );

    const lateKey = Uint8Array.from([9, 8, 7, 6]);

    internals.cacheSecretStorageKey(client, generation, "late-key", lateKey);
    assert.equal(
        lateKey.every((byte) => byte === 0),
        true,
    );
    assert.equal(internals.secretStorageKey, null);
});

test("a device verification request resolving after stop is cancelled without binding", async () => {
    const service = createService();
    let releaseRequest: () => void = () => undefined;
    let reportRequestStarted: () => void = () => undefined;
    const requestGate = new Promise<void>((resolve) => {
        releaseRequest = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
        reportRequestStarted = resolve;
    });
    let cancelCalls = 0;
    let requestListenerCalls = 0;
    const request = {
        initiatedByMe: true,
        pending: true,
        cancel: async () => {
            cancelCalls += 1;
            request.pending = false;
        },
        on: () => {
            requestListenerCalls += 1;
        },
    };
    const cryptoApi = {
        requestDeviceVerification: async () => {
            reportRequestStarted();
            await requestGate;

            return request;
        },
    };
    const client = {
        getCrypto: () => cryptoApi,
        off: () => undefined,
        stopClient: () => undefined,
    } as unknown as MatrixClient;
    const internals = service as unknown as {
        client: MatrixClient | null;
        activeVerification: unknown;
    };

    internals.client = client;
    const verificationResult = service
        .startDeviceVerification("OTHER_DEVICE")
        .catch((error: unknown) => error);

    await requestStarted;
    service.stop();
    releaseRequest();
    const verificationError = await verificationResult;

    assert.match((verificationError as Error).message, /session was locked/i);
    assert.equal(cancelCalls, 1);
    assert.equal(requestListenerCalls, 0);
    assert.equal(internals.activeVerification, null);
    assert.equal(service.getSnapshot().verification, null);
});

test("pagehide shutdown scrubs synchronously but retains ownership through pending work", async () => {
    let disposeCalls = 0;
    let accountLockReleaseCalls = 0;
    let vaultLockReleaseCalls = 0;
    const lease = {
        session: SESSION,
        recordId: "pagehide-record",
        revision: 1,
        cryptoDatabasePrefix: "pagehide-prefix",
        reseal: async () => undefined,
        dispose: () => {
            disposeCalls += 1;
        },
    };
    const service = new MatrixService(lease as never);
    let releasePendingRefresh: () => void = () => undefined;
    const pendingRefresh = new Promise<void>((resolve) => {
        releasePendingRefresh = resolve;
    });
    const uploadController = new AbortController();
    const secretKey = Uint8Array.from([9, 8, 7, 6]);
    const client = {
        off: () => undefined,
        stopClient: () => undefined,
    } as unknown as MatrixClient;
    const internals = service as unknown as {
        client: MatrixClient | null;
        refreshTask: Promise<unknown> | null;
        releaseLock: (() => void) | null;
        releaseVaultLock: (() => void) | null;
        activeUploadControllers: Set<AbortController>;
        secretStorageKey: [string, Uint8Array<ArrayBuffer>] | null;
    };

    internals.client = client;
    internals.refreshTask = pendingRefresh;

    internals.releaseLock = () => {
        accountLockReleaseCalls += 1;
    };

    internals.releaseVaultLock = () => {
        vaultLockReleaseCalls += 1;
    };

    internals.activeUploadControllers.add(uploadController);
    internals.secretStorageKey = ["pagehide-key", secretKey];

    const shutdown = service.shutdownForPageHide();

    assert.deepEqual(shutdown, { refreshInFlight: true });
    assert.equal(service.getSnapshot().userId, "");
    assert.equal(service.getSnapshot().deviceId, "");
    assert.equal(service.getSnapshot().rooms.length, 0);
    assert.equal(uploadController.signal.aborted, true);
    assert.equal(
        secretKey.every((byte) => byte === 0),
        true,
    );
    assert.equal(internals.secretStorageKey, null);
    assert.equal(disposeCalls, 1);
    assert.equal(accountLockReleaseCalls, 0);
    assert.equal(vaultLockReleaseCalls, 0);

    releasePendingRefresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(accountLockReleaseCalls, 1);
    assert.equal(vaultLockReleaseCalls, 1);

    assert.deepEqual(service.shutdownForPageHide(), { refreshInFlight: true });
    assert.equal(disposeCalls, 1);
    assert.equal(accountLockReleaseCalls, 1);
    assert.equal(vaultLockReleaseCalls, 1);
});

test("pagehide during the vault commit preserves the durably resealed OAuth session", async (t) => {
    const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    let releaseCommit = (): void => undefined;
    let reportCommitStarted = (): void => undefined;
    const commitGate = new Promise<void>((resolve) => {
        releaseCommit = resolve;
    });
    const commitStarted = new Promise<void>((resolve) => {
        reportCommitStarted = resolve;
    });
    let pauseNextTransactionCompletion = false;
    let service: MatrixService | null = null;
    let refreshResult: Promise<unknown> | null = null;

    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: new IDBFactory(),
        writable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async <T>(
                    name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => T | PromiseLike<T>,
                ): Promise<T> => callback({ name } as Lock),
            },
        },
    });

    const originalTransaction = FakeIDBDatabase.prototype.transaction;

    t.mock.method(
        FakeIDBDatabase.prototype,
        "transaction",
        function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
            const transaction = originalTransaction.apply(this, args);

            if (!pauseNextTransactionCompletion || args[1] !== "readwrite") {
                return transaction;
            }

            pauseNextTransactionCompletion = false;
            let completionHandler: ((this: IDBTransaction, event: Event) => unknown) | null = null;

            const delayedCompletion = (event: Event) => {
                reportCommitStarted();
                void commitGate.then(() => completionHandler?.call(transaction, event));
            };

            Object.defineProperty(transaction, "oncomplete", {
                configurable: true,
                enumerable: true,
                get: () => (completionHandler ? delayedCompletion : null),
                set: (handler: typeof completionHandler) => {
                    completionHandler = handler;
                },
            });

            return transaction;
        },
    );

    try {
        const recoveryKey = generateRecoveryKey();
        const original = createSession({
            accessToken: "pagehide-commit-access-old",
            authKind: "oauth",
            baseUrl: "https://matrix.example",
            deviceId: "PAGEHIDE_COMMIT_DEVICE",
            oauth: {
                clientId: "pagehide-commit-client",
                deviceId: "PAGEHIDE_COMMIT_OAUTH_DEVICE",
                redirectUri: "https://sub-etha.example/",
                metadata: {
                    authorization_endpoint: "https://issuer.example/authorize",
                    code_challenge_methods_supported: ["S256"],
                    grant_types_supported: ["authorization_code", "refresh_token"],
                    issuer: "https://issuer.example/",
                    registration_endpoint: "https://issuer.example/register",
                    response_modes_supported: ["query", "fragment"],
                    response_types_supported: ["code"],
                    revocation_endpoint: "https://issuer.example/revoke",
                    token_endpoint: "https://issuer.example/token",
                },
            },
            refreshToken: "pagehide-commit-refresh-old",
            userId: "@pagehide-commit:matrix.example",
        });
        const lease = await createLockedSession(original, recoveryKey);
        const revoked: string[] = [];

        t.mock.method(OAuth2.prototype, "performRefreshTokenGrant", async () => ({
            access_token: "pagehide-commit-access-new",
            refresh_token: "pagehide-commit-refresh-new",
            expires_in: 60,
        }));
        t.mock.method(
            OAuth2.prototype,
            "revokeToken",
            async (token: string, type?: "access_token" | "refresh_token") => {
                revoked.push(`${type}-${token}`);
            },
        );

        service = new MatrixService(lease);
        const internals = service as unknown as {
            refreshTokens: (refreshToken: string) => Promise<unknown>;
        };

        pauseNextTransactionCompletion = true;
        refreshResult = internals
            .refreshTokens("pagehide-commit-refresh-old")
            .catch((error: unknown) => error);

        await commitStarted;
        service.shutdownForPageHide();
        releaseCommit();

        const refreshError = await refreshResult;

        assert.match((refreshError as Error).message, /locked during token refresh/i);
        assert.deepEqual(revoked, []);

        const inspection = await inspectSession();

        assert.equal(inspection.kind, "locked");

        if (inspection.kind !== "locked") {
            throw new Error("Expected a locked session after the pagehide commit.");
        }

        const unlocked = await unlockSession(inspection, { kind: "recovery-key", recoveryKey });

        assert.equal(unlocked.session.accessToken, "pagehide-commit-access-new");
        assert.equal(unlocked.session.refreshToken, "pagehide-commit-refresh-new");
        unlocked.dispose();
    } finally {
        releaseCommit();
        service?.shutdownForPageHide();
        await refreshResult?.catch(() => undefined);

        if (indexedDbDescriptor) {
            Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "indexedDB");
        }

        if (navigatorDescriptor) {
            Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
        } else {
            Reflect.deleteProperty(globalThis, "navigator");
        }
    }
});

test("logout surfaces record deletion failure after disposing and releasing ownership", async () => {
    const deletionError = new Error("CAS deletion failed");
    let disposeCalls = 0;
    let releaseCalls = 0;
    let vaultReleaseCalls = 0;
    const lease = {
        session: SESSION,
        recordId: "logout-failure-record",
        revision: 9,
        cryptoDatabasePrefix: "logout-failure-prefix",
        reseal: async () => undefined,
        dispose: () => {
            disposeCalls += 1;
        },
    };
    const service = new MatrixService(lease as never);
    const internals = service as unknown as {
        client: {
            logout: () => Promise<void>;
            off: (...args: unknown[]) => void;
            stopClient: () => void;
        } | null;
        releaseLock: (() => void) | null;
        releaseVaultLock: (() => void) | null;
        deleteCurrentSession: () => Promise<SessionDeletionResult>;
    };

    internals.client = {
        logout: async () => undefined,
        off: () => undefined,
        stopClient: () => undefined,
    };

    internals.releaseLock = () => {
        releaseCalls += 1;
    };

    internals.releaseVaultLock = () => {
        vaultReleaseCalls += 1;
    };

    internals.deleteCurrentSession = async () => {
        throw deletionError;
    };

    await assert.rejects(service.logout(), deletionError);
    assert.equal(disposeCalls, 1);
    assert.equal(releaseCalls, 1);
    assert.equal(vaultReleaseCalls, 1);
    service.stop();
    assert.equal(disposeCalls, 1);
    assert.equal(releaseCalls, 1);
    assert.equal(vaultReleaseCalls, 1);
});
