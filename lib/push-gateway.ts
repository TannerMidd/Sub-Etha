import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { Agent } from "node:https";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

export interface MinimalMatrixNotification {
  event_id?: string;
  room_id?: string;
  counts?: { unread?: number; missed_calls?: number };
}

export type PushNotificationKind = "matrix" | "test";

export type PushHostResolver = (
  hostname: string,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

const BUILT_IN_PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "updates.push.services.mozilla.com",
]);

export function validPushKey(pushKey: unknown): pushKey is string {
  return typeof pushKey === "string" && /^[A-Za-z0-9_-]{40,128}$/.test(pushKey);
}

function configuredPushHosts(): string[] {
  return (process.env.PUSH_ENDPOINT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && !host.includes(".."));
}

function allowedPushHost(host: string, additionalHosts: Iterable<string>): boolean {
  if (BUILT_IN_PUSH_HOSTS.has(host)) return true;
  if (host.endsWith(".push.apple.com") || host.endsWith(".notify.windows.com")) return true;
  return new Set([...additionalHosts].map((value) => value.trim().toLowerCase())).has(host);
}

export function validPushEndpoint(raw: unknown, additionalHosts: Iterable<string> = configuredPushHosts()): raw is string {
  if (typeof raw !== "string" || raw.length > 2_048) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
    const host = url.hostname.toLowerCase();
    if (ipaddr.isValid(host)) return false;
    return allowedPushHost(host, additionalHosts);
  } catch {
    return false;
  }
}

export function isPublicIpAddress(raw: string): boolean {
  try {
    const parsed = ipaddr.parse(raw);
    if (parsed.kind() === "ipv6") {
      const ipv6 = parsed as ipaddr.IPv6;
      if (ipv6.isIPv4MappedAddress()) {
        return ipv6.toIPv4Address().range() === "unicast";
      }
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

function lookupError(message: string, code: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

function systemPushResolver(hostname: string, callback: Parameters<PushHostResolver>[1]): void {
  dnsLookup(hostname, { all: true, verbatim: true }, callback);
}

export function createPublicLookup(resolver: PushHostResolver = systemPushResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, (error, addresses) => {
      if (error) {
        callback(error, options.all ? [] : "", 0);
        return;
      }
      if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
        callback(lookupError("Push endpoint did not resolve exclusively to public addresses.", "EACCES"), options.all ? [] : "", 0);
        return;
      }
      const requestedFamily = options.family && options.family !== 0 ? Number(options.family) : 0;
      const matching = requestedFamily ? addresses.filter(({ family }) => family === requestedFamily) : addresses;
      if (!matching.length) {
        callback(lookupError("Push endpoint did not resolve for the requested address family.", "EAI_ADDRFAMILY"), options.all ? [] : "", 0);
        return;
      }
      if (options.all) {
        callback(null, matching);
        return;
      }
      callback(null, matching[0].address, matching[0].family);
    });
  };
}

export function createPublicPushAgent(resolver?: PushHostResolver): Agent {
  return new Agent({ keepAlive: false, lookup: createPublicLookup(resolver) });
}

export function genericNotificationPayload(notification: MinimalMatrixNotification, kind: PushNotificationKind = "matrix"): string {
  return JSON.stringify({
    kind,
    roomId: notification.room_id ?? null,
    eventId: notification.event_id ?? null,
    unread: Number.isFinite(notification.counts?.unread) ? Math.max(0, Number(notification.counts?.unread)) : 0,
  });
}
