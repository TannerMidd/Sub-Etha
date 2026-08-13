import {
    EventTimeline,
    EventType,
    NotificationCountType,
    type MatrixClient,
    type MatrixEvent,
    type Room,
} from "matrix-js-sdk";
import { stripPlainReplyFallback } from "./message-text";
import { sanitizeMatrixHtml } from "./trusted-html";
import type { ReactionSummary, RoomSummary, TimelineItem } from "./types";

export { sanitizeMatrixHtml } from "./trusted-html";

export function eventDecryptionState(
    event: Pick<
        MatrixEvent,
        "getType" | "isBeingDecrypted" | "isDecryptionFailure" | "isEncrypted"
    >,
): TimelineItem["decryptionState"] {
    if (!event.isEncrypted()) {
        return "ready";
    }

    if (event.isDecryptionFailure()) {
        return "failed";
    }

    if (event.isBeingDecrypted() || event.getType() === "m.room.encrypted") {
        return "decrypting";
    }

    return "ready";
}

function eventBody(event: MatrixEvent): string {
    if (event.isDecryptionFailure()) {
        return "This transmission could not be decrypted on this device.";
    }

    const replacing = event.replacingEvent();
    const replacingContent = replacing?.getContent<Record<string, unknown>>();
    const base =
        replacingContent?.["m.new_content"] ??
        event.getContent<Record<string, unknown>>()["m.new_content"] ??
        event.getContent();

    if (base && typeof base === "object" && "body" in base && typeof base.body === "string") {
        const relation = (base as Record<string, unknown>)["m.relates_to"] as
            { "m.in_reply_to"?: { event_id?: string } } | undefined;

        return relation?.["m.in_reply_to"]?.event_id
            ? stripPlainReplyFallback(base.body)
            : base.body;
    }

    return "";
}

function reactionMap(
    events: MatrixEvent[],
    ownUserId: string,
): Map<string, Map<string, { count: number; mine: boolean; ownEventId?: string }>> {
    const result = new Map<
        string,
        Map<string, { count: number; mine: boolean; ownEventId?: string }>
    >();

    for (const event of events) {
        if (event.getType() !== EventType.Reaction || event.getContent()["m.relates_to"] == null) {
            continue;
        }

        const relation = event.getContent()["m.relates_to"] as {
            event_id?: string;
            key?: string;
            rel_type?: string;
        };

        if (relation.rel_type !== "m.annotation" || !relation.event_id || !relation.key) {
            continue;
        }

        const byEvent =
            result.get(relation.event_id) ??
            new Map<string, { count: number; mine: boolean; ownEventId?: string }>();
        const current = byEvent.get(relation.key) ?? { count: 0, mine: false };

        current.count += 1;

        if (event.getSender() === ownUserId) {
            current.mine = true;
            current.ownEventId = event.getId() ?? undefined;
        }

        byEvent.set(relation.key, current);
        result.set(relation.event_id, byEvent);
    }

    return result;
}

function reactionsFor(
    eventId: string,
    reactions: ReturnType<typeof reactionMap>,
): ReactionSummary[] {
    return [...(reactions.get(eventId)?.entries() ?? [])]
        .map(([key, value]) => ({ key, ...value }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function classifyMessage(
    content: Record<string, unknown>,
    event: MatrixEvent,
): TimelineItem["type"] {
    if (event.isDecryptionFailure()) {
        return "encrypted";
    }

    if (event.getType() === EventType.RoomMember) {
        return "system";
    }

    const messageType = content.msgtype;

    if (messageType === "m.image") {
        return "image";
    }

    if (messageType === "m.video") {
        return "video";
    }

    if (messageType === "m.audio") {
        return "audio";
    }

    if (messageType === "m.file") {
        return "file";
    }

    if (messageType === "m.notice") {
        return "notice";
    }

    return "message";
}

function membershipBody(event: MatrixEvent, senderName: string): string {
    const membership = String(event.getContent().membership ?? "changed their membership");

    if (membership === "join") {
        return `${senderName} joined the room.`;
    }

    if (membership === "leave") {
        return `${senderName} left the room.`;
    }

    if (membership === "invite") {
        return `${senderName} sent an invitation.`;
    }

    if (membership === "ban") {
        return `${senderName} was banned.`;
    }

    return `${senderName} changed membership to ${membership}.`;
}

export function normalizeTimeline(room: Room, client: MatrixClient): TimelineItem[] {
    const events = room.getLiveTimeline().getEvents();
    const ownUserId = client.getUserId() ?? "";
    const reactions = reactionMap(events, ownUserId);
    const visible = events.filter((event) => {
        if (event.getType() === EventType.Reaction) {
            return false;
        }

        const relation = event.getRelation();

        if (relation?.rel_type === "m.replace") {
            return false;
        }

        return (
            event.getType() === EventType.RoomMessage ||
            event.getType() === "m.room.encrypted" ||
            event.getType() === EventType.RoomMember
        );
    });

    return visible.map((event) => {
        const senderId = event.getSender() ?? "";
        const member = room.getMember(senderId);
        const senderName = member?.name || senderId || "Unknown traveller";
        const replacing = event.replacingEvent();
        const replacingContent = replacing?.getContent<Record<string, unknown>>();
        const original = event.getContent<Record<string, unknown>>();
        const content = (replacingContent?.["m.new_content"] ??
            original["m.new_content"] ??
            original) as Record<string, unknown>;
        const relation = content["m.relates_to"] as
            { "m.in_reply_to"?: { event_id?: string } } | undefined;
        const eventId = event.getId() ?? `local-${event.getTs()}-${senderId}`;
        const mediaFile =
            content.file && typeof content.file === "object"
                ? (content.file as Record<string, unknown>)
                : undefined;
        const mxcUrl =
            typeof content.url === "string"
                ? content.url
                : typeof mediaFile?.url === "string"
                  ? mediaFile.url
                  : undefined;
        const readBy =
            eventId && event.getSender() === ownUserId
                ? room
                      .getMembers()
                      .filter(
                          (candidate) =>
                              candidate.userId !== ownUserId &&
                              room.hasUserReadEvent(candidate.userId, eventId),
                      )
                      .map((candidate) => candidate.name || candidate.userId)
                      .slice(0, 3)
                : [];
        const isMembership = event.getType() === EventType.RoomMember;
        const formattedBody =
            content.format === "org.matrix.custom.html" &&
            typeof content.formatted_body === "string"
                ? sanitizeMatrixHtml(content.formatted_body)
                : undefined;

        return {
            id: eventId,
            type: classifyMessage(content, event),
            senderId,
            senderName,
            senderAvatarMxcUrl: member?.getMxcAvatarUrl() ?? null,
            body: isMembership ? membershipBody(event, senderName) : eventBody(event),
            formattedBody,
            timestamp: event.getTs(),
            own: senderId === ownUserId,
            edited: Boolean(replacing || original["m.new_content"]),
            redacted: Object.keys(original).length === 0 && !event.isDecryptionFailure(),
            encrypted: event.isEncrypted(),
            decryptionState: eventDecryptionState(event),
            media: mxcUrl
                ? {
                      mxcUrl,
                      mimeType:
                          typeof (content.info as Record<string, unknown> | undefined)?.mimetype ===
                          "string"
                              ? String((content.info as Record<string, unknown>).mimetype)
                              : undefined,
                      size:
                          typeof (content.info as Record<string, unknown> | undefined)?.size ===
                          "number"
                              ? Number((content.info as Record<string, unknown>).size)
                              : undefined,
                      width:
                          typeof (content.info as Record<string, unknown> | undefined)?.w ===
                          "number"
                              ? Number((content.info as Record<string, unknown>).w)
                              : undefined,
                      height:
                          typeof (content.info as Record<string, unknown> | undefined)?.h ===
                          "number"
                              ? Number((content.info as Record<string, unknown>).h)
                              : undefined,
                      encryptedFile: mediaFile,
                  }
                : undefined,
            replyTo: relation?.["m.in_reply_to"]?.event_id,
            reactions: reactionsFor(eventId, reactions),
            sendingStatus: event.status,
            readBy,
            event,
        };
    });
}

function lastMessageText(room: Room): string {
    const last = room.getLastLiveEvent();

    if (!last) {
        return room.getMyMembership() === "invite" ? "Invitation waiting" : "No transmissions yet";
    }

    if (eventDecryptionState(last) === "decrypting") {
        return "Decrypting transmission…";
    }

    const body = eventBody(last);

    if (body) {
        return body;
    }

    if (last.getType() === EventType.RoomMember) {
        return "Room membership changed";
    }

    return "New activity";
}

export function roomAvatarMxcUrl(
    room: Pick<Room, "getMxcAvatarUrl" | "getAvatarFallbackMember">,
): string | null {
    return room.getMxcAvatarUrl() ?? room.getAvatarFallbackMember()?.getMxcAvatarUrl() ?? null;
}

export function normalizeRooms(client: MatrixClient): RoomSummary[] {
    const rooms = client
        .getRooms()
        .filter((room) => ["join", "invite"].includes(room.getMyMembership()))
        .map((room) => {
            const mutedRule = client.getRoomPushRule("global", room.roomId);
            const currentState = room.getLiveTimeline().getState(EventTimeline.FORWARDS);
            const topicEvent = currentState?.getStateEvents(EventType.RoomTopic, "");
            const topic = String(topicEvent?.getContent().topic ?? "").trim() || null;

            return {
                id: room.roomId,
                name: room.name || room.getDefaultRoomName(client.getUserId() ?? ""),
                topic,
                avatarMxcUrl: roomAvatarMxcUrl(room),
                membership: room.getMyMembership(),
                lastMessage: lastMessageText(room),
                timestamp: room.getLastActiveTimestamp(),
                unread: room.getUnreadNotificationCount(NotificationCountType.Total),
                highlights: room.getUnreadNotificationCount(NotificationCountType.Highlight),
                encrypted: room.hasEncryptionStateEvent(),
                favourite: Boolean(room.tags?.["m.favourite"]),
                muted: Boolean(mutedRule && mutedRule.actions.length === 0),
                memberCount: room.getJoinedMemberCount(),
                room,
            };
        });

    return sortRoomSummaries(rooms);
}

export function sortRoomSummaries(rooms: RoomSummary[]): RoomSummary[] {
    return [...rooms].sort((left, right) => {
        if (left.membership !== right.membership) {
            return left.membership === "invite" ? -1 : 1;
        }

        if (left.favourite !== right.favourite) {
            return left.favourite ? -1 : 1;
        }

        if (Boolean(left.unread) !== Boolean(right.unread)) {
            return left.unread ? -1 : 1;
        }

        return right.timestamp - left.timestamp;
    });
}
