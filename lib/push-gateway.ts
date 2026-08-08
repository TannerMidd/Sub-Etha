export interface MinimalMatrixNotification {
  event_id?: string;
  room_id?: string;
  counts?: { unread?: number; missed_calls?: number };
}

export function validPushKey(pushKey: unknown): pushKey is string {
  return typeof pushKey === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(pushKey);
}

export function validPushEndpoint(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2_048) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) return false;
    if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export function genericNotificationPayload(notification: MinimalMatrixNotification): string {
  return JSON.stringify({
    roomId: notification.room_id ?? null,
    eventId: notification.event_id ?? null,
    unread: Number.isFinite(notification.counts?.unread) ? Math.max(0, Number(notification.counts?.unread)) : 0,
  });
}
