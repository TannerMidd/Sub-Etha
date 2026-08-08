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
  if (options.replyUserId) userIds.push(options.replyUserId);
  const mentions = {
    user_ids: [...new Set(userIds)],
    ...(trimmed.includes("@room") ? { room: true } : {}),
  };
  const plainContent: Record<string, unknown> = {
    msgtype: "m.text",
    body: trimmed,
    ...(mentions.user_ids.length || "room" in mentions ? { "m.mentions": mentions } : {}),
  };
  if (options.replyTo) {
    return { ...plainContent, "m.relates_to": { "m.in_reply_to": { event_id: options.replyTo } } };
  }
  if (options.editEventId) {
    return {
      msgtype: "m.text",
      body: `* ${trimmed}`,
      "m.new_content": plainContent,
      "m.relates_to": { rel_type: RelationType.Replace, event_id: options.editEventId },
      ...(plainContent["m.mentions"] ? { "m.mentions": plainContent["m.mentions"] } : {}),
    };
  }
  return plainContent;
}
