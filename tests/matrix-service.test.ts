import assert from "node:assert/strict";
import test from "node:test";
import { MatrixService } from "../lib/matrix/client";
import type { PersistedMatrixSession } from "../lib/matrix/types";

const SESSION: PersistedMatrixSession = {
  accessToken: "token",
  authKind: "token",
  baseUrl: "https://matrix.example",
  cryptoStorageKey: "AQID",
  deviceId: "DEVICE",
  userId: "@arthur:matrix.example",
};

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
      Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  }
});

test("back-pagination timeline events stay hidden until pagination emits its atomic snapshot", () => {
  const service = new MatrixService(SESSION);
  const refreshes: boolean[] = [];
  const internals = service as unknown as {
    handleTimeline: (event: unknown, room: { roomId: string }, toStartOfTimeline?: boolean) => void;
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
