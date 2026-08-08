"use client";

import { useEffect, useState } from "react";
import type { MatrixService } from "@/lib/matrix/client";
import type { MatrixSnapshot, RoomSummary, TimelineItem } from "@/lib/matrix/types";
import { ChatShell } from "./ChatShell";

const at = (hour: number, minute: number) => new Date(2026, 7, 8, hour, minute).getTime();

function previewRoom(id: string, name: string, memberCount: number, lastMessage: string, timestamp: number, unread = 0, favourite = false): RoomSummary {
  return {
    id,
    name,
    avatarUrl: id === "signal-watch" ? "/night-receiver-plate.png" : null,
    membership: "join",
    lastMessage,
    timestamp,
    unread,
    highlights: unread > 2 ? 1 : 0,
    encrypted: true,
    favourite,
    muted: false,
    memberCount,
    room: {} as RoomSummary["room"],
  };
}

function previewMessage(id: string, senderName: string, body: string, timestamp: number, own = false, extra: Partial<TimelineItem> = {}): TimelineItem {
  return {
    id,
    type: "message",
    senderId: `@${senderName.toLowerCase().replace(/\s+/g, "-")}:sub-etha.test`,
    senderName,
    senderAvatarUrl: senderName === "Vera" ? "/night-receiver-plate.png" : null,
    body,
    timestamp,
    own,
    edited: false,
    redacted: false,
    encrypted: true,
    decryptionFailed: false,
    reactions: [],
    sendingStatus: null,
    readBy: [],
    event: {} as TimelineItem["event"],
    ...extra,
  };
}

function createPreviewService(): MatrixService {
  const listeners = new Set<() => void>();
  let snapshot: MatrixSnapshot = {
    connection: "ready",
    rooms: [
      previewRoom("signal-watch", "Signal Watch", 7, "Scheduling maintenance for 2100.", at(10, 42), 1, true),
      previewRoom("hab-drift", "Hab Drift Crew", 5, "Sweep complete on the north arc.", at(9, 18), 0, true),
      previewRoom("archive-echoes", "Archive — Echoes", 12, "The old relay notes are indexed.", at(8, 7), 1),
      previewRoom("observatory", "Observatory", 3, "Clear skies on the western array.", at(7, 36)),
      previewRoom("grid-maintenance", "Grid Maintenance", 9, "Coil batch cleared customs.", at(6, 51)),
      previewRoom("quiet-room", "Quiet Room", 2, "No new transmissions.", at(6, 12)),
      previewRoom("maris", "Maris", 2, "See you on the far side.", at(5, 48)),
      previewRoom("ilya", "Ilya", 2, "Typing…", at(5, 42), 1),
    ],
    activeRoomId: "signal-watch",
    timeline: [
      previewMessage("m1", "Vera", "Weak carrier riding the band. Not our bird.\nLogging and letting it pass.", at(10, 18), false, { reactions: [{ key: "📡", count: 3, mine: true }, { key: "👁", count: 1, mine: false }] }),
      previewMessage("m2", "Sol", "Copy. I’ll continue the sweep on the north arc\nand report any anomalies.", at(10, 21)),
      previewMessage("m3", "Tamsin", "Power fluctuation on Relay 7B at 03:17.\nNothing persistent.", at(10, 24)),
      previewMessage("m4", "Vera", "Thanks. I’ve annotated the spike.", at(10, 25), false, { replyTo: "m3" }),
      previewMessage("m5", "Sol", "Looks like background ion wash. Within margin.", at(10, 26), true),
      previewMessage("m6", "Rook", "Did we get the new coil batch manifest?\nLogistics said it cleared customs.", at(10, 31)),
      previewMessage("m7", "Vera", "Yes. Dockside locker. Seal intact.", at(10, 33), false, { reactions: [{ key: "👍", count: 2, mine: false }] }),
      previewMessage("m8", "Tamsin", "Scheduling maintenance window for 2100.\nI’ll drop the calendar invite.", at(10, 42)),
    ],
    typingNames: [],
    loadingHistory: false,
    error: null,
    userId: "@rayne:sub-etha.test",
    displayName: "Rayne",
    avatarUrl: "/night-receiver-plate.png",
    deviceId: "FIELD-GUIDE-01",
  };

  const emit = () => listeners.forEach((listener) => listener());
  const update = (next: Partial<MatrixSnapshot>) => { snapshot = { ...snapshot, ...next }; emit(); };

  const service = {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    getSnapshot: () => snapshot,
    selectRoom: (roomId: string) => update({ activeRoomId: roomId }),
    clearError: () => update({ error: null }),
    paginate: async () => undefined,
    react: async (eventId: string, key: string) => {
      update({ timeline: snapshot.timeline.map((item) => item.id === eventId ? { ...item, reactions: [...item.reactions.filter((reaction) => reaction.key !== key), { key, count: (item.reactions.find((reaction) => reaction.key === key)?.count ?? 0) + 1, mine: true }] } : item) });
    },
    retry: async () => undefined,
    redact: async (eventId: string) => update({ timeline: snapshot.timeline.map((item) => item.id === eventId ? { ...item, redacted: true, body: "" } : item) }),
    setTyping: async (typing: boolean) => update({ typingNames: typing ? ["Sol"] : [] }),
    sendText: async (body: string) => update({ timeline: [...snapshot.timeline, previewMessage(`m${Date.now()}`, "Rayne", body, Date.now(), true, { readBy: ["Vera"] })] }),
    sendFile: async () => undefined,
    getMediaUrl: async () => "",
    createRoom: async () => undefined,
    joinRoom: async (roomId: string) => update({ activeRoomId: roomId }),
    leaveActiveRoom: async () => update({ activeRoomId: null }),
    searchCurrentRoom: async (term: string) => snapshot.timeline.filter((item) => item.body.toLowerCase().includes(term.toLowerCase())),
    invite: async () => undefined,
    setRoomMuted: async (muted: boolean) => update({ rooms: snapshot.rooms.map((room) => room.id === snapshot.activeRoomId ? { ...room, muted } : room) }),
    getDevices: async () => [{ deviceId: snapshot.deviceId, displayName: "Sub-Etha field receiver", current: true }],
    getCryptoStatus: async () => ({ secretStorageReady: true, crossSigningReady: true, backupVersion: "1" }),
    updateProfile: async (displayName: string) => update({ displayName }),
    setupRecovery: async () => "DEMO RECOVERY KEY",
    unlockRecovery: async () => undefined,
    verifyWithAnotherDevice: async () => undefined,
    logout: async () => undefined,
  };

  return service as unknown as MatrixService;
}

export function DesignPreview() {
  const [service] = useState(createPreviewService);
  useEffect(() => {
    const previousTheme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = "dark";
    return () => {
      if (previousTheme) document.documentElement.dataset.theme = previousTheme;
      else document.documentElement.removeAttribute("data-theme");
    };
  }, []);
  return <ChatShell service={service} onLogout={async () => undefined} />;
}
