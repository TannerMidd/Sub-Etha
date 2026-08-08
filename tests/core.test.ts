import assert from "node:assert/strict";
import test from "node:test";
import { humanizeMatrixError, normalizeHomeserverInput, sanitizedCallbackPath } from "../lib/matrix/auth";
import { base64UrlToBytes, createSession, randomBase64Url } from "../lib/matrix/session-store";
import type { RoomSummary } from "../lib/matrix/types";
import { sortRoomSummaries } from "../lib/matrix/normalize";
import { genericNotificationPayload, validPushEndpoint, validPushKey } from "../lib/push-gateway";
import { createTextContent } from "../lib/matrix/message-content";

test("homeserver input accepts Matrix IDs, domains, and explicit URLs", () => {
  assert.deepEqual(normalizeHomeserverInput("@arthur:matrix.example"), { serverName: "matrix.example" });
  assert.deepEqual(normalizeHomeserverInput("matrix.example"), { serverName: "matrix.example" });
  assert.deepEqual(normalizeHomeserverInput("https://matrix.example/client/"), {
    serverName: "matrix.example",
    explicitUrl: "https://matrix.example",
  });
  assert.throws(() => normalizeHomeserverInput("not a server"), /Matrix server/i);
});

test("authentication errors are direct and callback credentials are removed", () => {
  assert.equal(humanizeMatrixError({ errcode: "M_FORBIDDEN" }), "The homeserver declined those credentials.");
  assert.equal(sanitizedCallbackPath("/", "#code=private&state=private"), "/");
  assert.equal(sanitizedCallbackPath("/", "#/room/%21safe%3Aexample"), "/#/room/%21safe%3Aexample");
});

test("session crypto storage keys are device-local, random, and reversible", () => {
  const first = randomBase64Url(32);
  const second = randomBase64Url(32);
  assert.notEqual(first, second);
  assert.equal(base64UrlToBytes(first).byteLength, 32);
  const session = createSession({
    baseUrl: "https://matrix.example",
    userId: "@arthur:matrix.example",
    deviceId: "DEVICE",
    accessToken: "private",
    authKind: "token",
  });
  assert.equal(base64UrlToBytes(session.cryptoStorageKey).byteLength, 32);
});

test("room sorting prioritizes invites, favourites, unread rooms, then recency", () => {
  const room = (id: string, values: Partial<RoomSummary>): RoomSummary => ({
    id,
    name: id,
    avatarUrl: null,
    membership: "join",
    lastMessage: "",
    timestamp: 0,
    unread: 0,
    highlights: 0,
    encrypted: true,
    favourite: false,
    muted: false,
    memberCount: 2,
    room: {} as RoomSummary["room"],
    ...values,
  });
  const sorted = sortRoomSummaries([
    room("old", { timestamp: 1 }),
    room("unread", { unread: 2 }),
    room("invite", { membership: "invite" }),
    room("favourite", { favourite: true }),
    room("new", { timestamp: 9 }),
  ]);
  assert.deepEqual(sorted.map(({ id }) => id), ["invite", "favourite", "unread", "new", "old"]);
});

test("push gateway validates opaque keys and public HTTPS endpoints", () => {
  assert.equal(validPushKey("a".repeat(40)), true);
  assert.equal(validPushKey("short"), false);
  assert.equal(validPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/example"), true);
  assert.equal(validPushEndpoint("http://push.example/device"), false);
  assert.equal(validPushEndpoint("https://127.0.0.1/device"), false);
  assert.equal(validPushEndpoint("https://192.168.1.2/device"), false);
});

test("push payload discards Matrix content and identity fields", () => {
  const payload = JSON.parse(genericNotificationPayload({
    event_id: "$event",
    room_id: "!room:example",
    counts: { unread: 3 },
    body: "secret text",
    sender: "@ford:example",
  } as Parameters<typeof genericNotificationPayload>[0] & { body: string; sender: string }));
  assert.deepEqual(payload, { roomId: "!room:example", eventId: "$event", unread: 3 });
  assert.equal(JSON.stringify(payload).includes("secret"), false);
  assert.equal(JSON.stringify(payload).includes("ford"), false);
});

test("message content carries Matrix mentions, replies, and edits", () => {
  const reply = createTextContent("Hello @ford:example.org and @room", {
    replyTo: "$earlier",
    replyUserId: "@trillian:example.org",
  });
  assert.deepEqual(reply["m.mentions"], {
    user_ids: ["@ford:example.org", "@trillian:example.org"],
    room: true,
  });
  assert.deepEqual(reply["m.relates_to"], { "m.in_reply_to": { event_id: "$earlier" } });
  const edit = createTextContent("Corrected", { editEventId: "$original" });
  assert.equal((edit["m.new_content"] as { body: string }).body, "Corrected");
  assert.deepEqual(edit["m.relates_to"], { rel_type: "m.replace", event_id: "$original" });
});
