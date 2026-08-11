import assert from "node:assert/strict";
import test from "node:test";
import { MatrixService } from "../lib/matrix/client";
import type { MatrixSnapshot, PersistedMatrixSession, TimelineItem } from "../lib/matrix/types";

const SESSION: PersistedMatrixSession = {
    accessToken: "token",
    authKind: "token",
    baseUrl: "https://matrix.example",
    cryptoStorageKey: "AQID",
    deviceId: "DEVICE",
    userId: "@arthur:matrix.example",
    storageMode: "remembered",
    localStoreId: "AAAAAAAAAAAAAAAAAAAAAA" as PersistedMatrixSession["localStoreId"],
    cryptoDatabasePrefix: "sub-etha-crypto-AAAAAAAAAAAAAAAAAAAAAA",
};

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

    return {
        roomId,
        oldState: { paginationToken: token },
        events,
        getLiveTimeline: () => ({ getEvents: () => events }),
        getMember: () => ({ name: "Ford", getMxcAvatarUrl: () => null }),
        getMembers: () => [],
        hasUserReadEvent: () => false,
        decryptAllEvents: async () => undefined,
    };
}

function paginationInternals(service: MatrixService) {
    return service as unknown as {
        client: {
            getRoom: (roomId: string) => ReturnType<typeof timelineRoom> | null;
            getUserId: () => string;
            scrollback: (room: ReturnType<typeof timelineRoom>, limit: number) => Promise<void>;
        };
        snapshot: MatrixSnapshot;
        stopped: boolean;
    };
}

test("room read markers coalesce duplicates and advance to the newest event", async () => {
    const service = new MatrixService(SESSION);
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
    const service = new MatrixService(SESSION);
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
    const service = new MatrixService(SESSION);
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
    const service = new MatrixService(SESSION);
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
            target.oldState.paginationToken = null;
        },
    };
    internals.snapshot.activeRoomId = room.roomId;
    internals.snapshot.timeline = [timelineItem("$current-1"), timelineItem("$current-2")];
    internals.snapshot.hasMoreHistory = true;
    internals.stopped = true;

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
    const service = new MatrixService(SESSION);
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
            target.oldState.paginationToken = null;
        },
    };
    internals.snapshot.activeRoomId = room.roomId;
    internals.snapshot.timeline = [timelineItem("$current")];
    internals.snapshot.hasMoreHistory = true;
    internals.stopped = true;

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
    const service = new MatrixService(SESSION);
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
            target.oldState.paginationToken = null;
        },
    };
    internals.snapshot.activeRoomId = oldRoom.roomId;
    internals.snapshot.timeline = [timelineItem("$old-current")];
    internals.snapshot.hasMoreHistory = true;
    internals.stopped = true;

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
