import assert from "node:assert/strict";
import { File as NodeFile } from "node:buffer";
import test from "node:test";
import { humanizeMatrixError, normalizeHomeserverInput, sanitizedCallbackPath } from "../lib/matrix/auth";
import { base64UrlToBytes, createSession, randomBase64Url } from "../lib/matrix/session-store";
import type { RoomSummary } from "../lib/matrix/types";
import { roomAvatarMxcUrl, sortRoomSummaries } from "../lib/matrix/normalize";
import { genericNotificationPayload, validPushEndpoint, validPushKey } from "../lib/push-gateway";
import { createMediaContent, createTextContent } from "../lib/matrix/message-content";
import { messageTextSegments, stripPlainReplyFallback } from "../lib/matrix/message-text";
import { findOwnReactionEventId, mediaAuthorizationHeaders, shouldTryLegacyMedia } from "../lib/matrix/client";
import { bytesAreGif, firstImageFile, insertAtSelection, normalizeMediaFile } from "../lib/matrix/media";
import { relayToPushGateway } from "../lib/vercel-push-proxy";

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
    avatarMxcUrl: null,
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

test("room avatars prefer an explicit room image and fall back to the other DM member", () => {
  const fallbackMember = { getMxcAvatarUrl: () => "mxc://example/dm-avatar" };
  assert.equal(roomAvatarMxcUrl({
    getMxcAvatarUrl: () => "mxc://example/room-avatar",
    getAvatarFallbackMember: () => fallbackMember,
  } as never), "mxc://example/room-avatar");
  assert.equal(roomAvatarMxcUrl({
    getMxcAvatarUrl: () => null,
    getAvatarFallbackMember: () => fallbackMember,
  } as never), "mxc://example/dm-avatar");
});

test("authenticated media credentials are restricted to the homeserver origin", () => {
  assert.deepEqual(
    mediaAuthorizationHeaders("https://matrix.example/_matrix/client/v1/media/download/a/b", "https://matrix.example", "secret"),
    { Authorization: "Bearer secret" },
  );
  assert.throws(
    () => mediaAuthorizationHeaders("https://media.attacker.example/image", "https://matrix.example", "secret"),
    /unexpected media host/i,
  );
  assert.equal(mediaAuthorizationHeaders("https://matrix.example/image", "https://matrix.example", null), undefined);
  assert.equal(shouldTryLegacyMedia(404), true);
  assert.equal(shouldTryLegacyMedia(501), true);
  assert.equal(shouldTryLegacyMedia(401), false);
  assert.equal(shouldTryLegacyMedia(500), false);
});

test("GIF clipboard files are recognized even when the keyboard omits MIME metadata", async () => {
  const bytes = new TextEncoder().encode("GIF89a placeholder");
  assert.equal(bytesAreGif(bytes), true);
  const raw = new NodeFile([bytes], "image.", { type: "" }) as unknown as File;
  const normalized = await normalizeMediaFile(raw);
  assert.equal(normalized.type, "image/gif");
  assert.match(normalized.name, /\.gif$/);
  const transfer = {
    items: [{ kind: "file", type: "", getAsFile: () => raw }],
    files: [],
  } as unknown as DataTransfer;
  assert.equal(firstImageFile(transfer), raw);
});

test("emoji insertion replaces the active composer selection and returns the new caret", () => {
  assert.deepEqual(insertAtSelection("Hello world", "🛰️", 6, 11), { value: "Hello 🛰️", caret: 9 });
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

test("Vercel push relay forwards only the privacy-minimal request to the established gateway", async () => {
  const originalFetch = globalThis.fetch;
  const originalGateway = process.env.SUB_ETHA_PUSH_GATEWAY_ORIGIN;
  process.env.SUB_ETHA_PUSH_GATEWAY_ORIGIN = "https://push.sub-etha.example";
  const calls: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    return Response.json({ registered: true });
  };
  try {
    const response = await relayToPushGateway(new Request("https://sub-etha.vercel.app/api/push/subscriptions", {
      method: "POST",
      headers: {
        Authorization: "Bearer must-not-travel",
        "Content-Type": "application/json",
        Origin: "https://sub-etha.vercel.app",
      },
      body: JSON.stringify({ pushKey: "a".repeat(40) }),
    }), "/api/push/subscriptions");
    assert.equal(response.status, 200);
    const observed = calls[0];
    assert.ok(observed);
    assert.equal(observed.url, "https://push.sub-etha.example/api/push/subscriptions");
    assert.equal(observed.headers.get("origin"), "https://push.sub-etha.example");
    assert.equal(observed.headers.has("authorization"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGateway === undefined) delete process.env.SUB_ETHA_PUSH_GATEWAY_ORIGIN;
    else process.env.SUB_ETHA_PUSH_GATEWAY_ORIGIN = originalGateway;
  }
});

test("Vercel mirror fails closed when no public push gateway is configured", async () => {
  const originalGateway = process.env.SUB_ETHA_PUSH_GATEWAY_ORIGIN;
  delete process.env.SUB_ETHA_PUSH_GATEWAY_ORIGIN;
  try {
    const response = await relayToPushGateway(new Request("https://sub-etha.vercel.app/api/push/vapid-key"), "/api/push/vapid-key");
    assert.equal(response.status, 503);
    assert.match(await response.text(), /not configured/i);
  } finally {
    if (originalGateway !== undefined) process.env.SUB_ETHA_PUSH_GATEWAY_ORIGIN = originalGateway;
  }
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
  const edit = createTextContent("Corrected", { editEventId: "$original", replyTo: "$earlier" });
  assert.equal((edit["m.new_content"] as { body: string }).body, "Corrected");
  assert.deepEqual((edit["m.new_content"] as Record<string, unknown>)["m.relates_to"], { "m.in_reply_to": { event_id: "$earlier" } });
  assert.deepEqual(edit["m.relates_to"], { rel_type: "m.replace", event_id: "$original" });
});

test("plain message text recognizes links without swallowing sentence punctuation", () => {
  assert.deepEqual(messageTextSegments("See https://example.org/docs_(v2), www.matrix.org or crew@example.org."), [
    { text: "See " },
    { text: "https://example.org/docs_(v2)", href: "https://example.org/docs_(v2)" },
    { text: ", " },
    { text: "www.matrix.org", href: "https://www.matrix.org" },
    { text: " or " },
    { text: "crew@example.org", href: "mailto:crew@example.org" },
    { text: "." },
  ]);
  assert.equal(stripPlainReplyFallback("> <@ford:example.org> Earlier\n> message\n\nActual reply"), "Actual reply");
  assert.equal(stripPlainReplyFallback("> This is an ordinary quote"), "");
});

test("image attachments preserve captions, dimensions, encryption metadata, and replies", () => {
  const content = createMediaContent({
    fileName: "signal.gif",
    mimeType: "image/gif",
    contentUri: "mxc://example/media",
    info: { mimetype: "image/gif", size: 42, w: 320, h: 240 },
    caption: "A moving signal",
    replyTo: "$earlier",
    encryptedFile: { key: { k: "secret" }, iv: "iv", hashes: { sha256: "hash" }, v: "v2" },
  });
  assert.equal(content.msgtype, "m.image");
  assert.equal(content.body, "A moving signal");
  assert.equal(content.filename, "signal.gif");
  assert.deepEqual(content["m.relates_to"], { "m.in_reply_to": { event_id: "$earlier" } });
  assert.equal((content.file as { url: string }).url, "mxc://example/media");
  assert.equal("url" in content, false);
});

test("reaction toggling identifies the current user's relation for redaction", () => {
  const timeline = [{ id: "$message", reactions: [
    { key: "👍", count: 2, mine: true, ownEventId: "$my-reaction" },
    { key: "🎉", count: 1, mine: false },
  ] }] as never;
  assert.equal(findOwnReactionEventId(timeline, "$message", "👍"), "$my-reaction");
  assert.equal(findOwnReactionEventId(timeline, "$message", "🎉"), null);
});
