import { RelationType } from "matrix-js-sdk";

function mentionedUserIds(body: string): string[] {
    return [...new Set(body.match(/@[A-Za-z0-9._=/+-]+:[A-Za-z0-9._:-]+/g) ?? [])];
}

export function createTextContent(
    body: string,
    options: { replyTo?: string; replyUserId?: string; editEventId?: string } = {},
): Record<string, unknown> {
    const trimmed = body.trim();
    const userIds = mentionedUserIds(trimmed);

    if (options.replyUserId) {
        userIds.push(options.replyUserId);
    }

    const mentions = {
        user_ids: [...new Set(userIds)],
        ...(trimmed.includes("@room") ? { room: true } : {}),
    };
    const plainContent: Record<string, unknown> = {
        msgtype: "m.text",
        body: trimmed,
        ...(mentions.user_ids.length || "room" in mentions ? { "m.mentions": mentions } : {}),
    };

    if (options.editEventId) {
        const replacementContent = options.replyTo
            ? {
                  ...plainContent,
                  "m.relates_to": { "m.in_reply_to": { event_id: options.replyTo } },
              }
            : plainContent;

        return {
            msgtype: "m.text",
            body: `* ${trimmed}`,
            "m.new_content": replacementContent,
            "m.relates_to": { rel_type: RelationType.Replace, event_id: options.editEventId },
            ...(plainContent["m.mentions"] ? { "m.mentions": plainContent["m.mentions"] } : {}),
        };
    }

    if (options.replyTo) {
        return {
            ...plainContent,
            "m.relates_to": { "m.in_reply_to": { event_id: options.replyTo } },
        };
    }

    return plainContent;
}

const MEDIA_MESSAGE_TYPES = new Set(["m.image", "m.video", "m.audio", "m.file"]);

export function isMediaMessageContent(content: Record<string, unknown>): boolean {
    return typeof content.msgtype === "string" && MEDIA_MESSAGE_TYPES.has(content.msgtype);
}

export function createMediaEditContent(
    originalContent: Record<string, unknown>,
    body: string,
    editEventId: string,
): Record<string, unknown> {
    if (!isMediaMessageContent(originalContent)) {
        throw new Error("Only media messages can use media caption edits.");
    }

    const originalBody =
        typeof originalContent.body === "string" && originalContent.body.trim()
            ? originalContent.body.trim()
            : "attachment";
    const fileName =
        typeof originalContent.filename === "string" && originalContent.filename.trim()
            ? originalContent.filename.trim()
            : originalBody;
    const caption = body.trim();
    const replacementContent: Record<string, unknown> = {
        ...originalContent,
        body: caption || fileName,
        filename: fileName,
    };

    // The composer edits plain captions. Do not leave a stale rich caption in
    // place after its plain-text counterpart changes.
    delete replacementContent.format;
    delete replacementContent.formatted_body;
    delete replacementContent["m.new_content"];

    return {
        msgtype: originalContent.msgtype,
        body: `* ${caption || fileName}`,
        "m.new_content": replacementContent,
        "m.relates_to": { rel_type: RelationType.Replace, event_id: editEventId },
    };
}

function mediaMessageType(mimeType: string): string {
    if (mimeType.startsWith("image/")) {
        return "m.image";
    }

    if (mimeType.startsWith("video/")) {
        return "m.video";
    }

    if (mimeType.startsWith("audio/")) {
        return "m.audio";
    }

    return "m.file";
}

export function createMediaContent(options: {
    fileName: string;
    mimeType: string;
    contentUri: string;
    info: Record<string, unknown>;
    caption?: string;
    replyTo?: string;
    encryptedFile?: Record<string, unknown>;
}): Record<string, unknown> {
    const caption = options.caption?.trim();
    const content: Record<string, unknown> = {
        msgtype: mediaMessageType(options.mimeType),
        body: caption || options.fileName,
        info: options.info,
    };

    if (caption) {
        content.filename = options.fileName;
    }

    if (options.replyTo) {
        content["m.relates_to"] = { "m.in_reply_to": { event_id: options.replyTo } };
    }

    if (options.encryptedFile) {
        content.file = { ...options.encryptedFile, url: options.contentUri };
    } else {
        content.url = options.contentUri;
    }

    return content;
}
