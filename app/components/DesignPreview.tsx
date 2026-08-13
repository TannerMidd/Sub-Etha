"use client";

import { useEffect, useState } from "react";
import type { MatrixService } from "@/lib/matrix/client";
import type { MatrixMediaRef, MatrixSnapshot, RoomSummary, TimelineItem } from "@/lib/matrix/types";
import { INITIAL_TIMELINE_ITEM_INDEX } from "@/lib/timeline-window";
import { ChatShell } from "./ChatShell";
import { LoginScreen } from "./LoginScreen";

/*
 * The reference frames are all one day's conversation under a "Today" divider,
 * so the fixture hangs its clock times off the current date rather than a fixed
 * one. A pinned date would age out of "Today" the next morning and quietly move
 * the divider — and every visual baseline captured against it — as the label
 * changed width.
 */
const at = (hour: number, minute: number) => {
    const today = new Date();

    return new Date(today.getFullYear(), today.getMonth(), today.getDate(), hour, minute).getTime();
};

const STRESS_INITIAL_START = 80;
const STRESS_INITIAL_COUNT = 120;
const STRESS_PAGE_SIZE = 40;

function previewRoom(
    id: string,
    name: string,
    guideCode: string,
    memberCount: number,
    lastMessage: string,
    timestamp: number,
    unread = 0,
    favourite = false,
    topic: string | null = null,
    classification?: string,
    membership: RoomSummary["membership"] = "join",
): RoomSummary {
    return {
        id,
        name,
        guideCode,
        topic,
        classification,
        avatarMxcUrl: id === "signal-watch" ? "mxc://preview/zen-mark" : null,
        membership,
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

function previewMessage(
    id: string,
    senderName: string,
    body: string,
    timestamp: number,
    own = false,
    extra: Partial<TimelineItem> = {},
): TimelineItem {
    return {
        id,
        type: "message",
        senderId: `@${senderName.toLowerCase().replace(/\s+/g, "-")}:sub-etha.test`,
        senderName,
        senderAvatarMxcUrl: senderName === "Vera" ? "mxc://preview/zen-mark" : null,
        body,
        timestamp,
        own,
        edited: false,
        redacted: false,
        encrypted: true,
        decryptionState: "ready",
        reactions: [],
        sendingStatus: null,
        readBy: [],
        event: {} as TimelineItem["event"],
        ...extra,
    };
}

function stressBody(index: number): string {
    const details = "Carrier trace remains inside the expected margin. "
        .repeat(1 + (index % 3))
        .trim();

    return `Transmission ${index}. ${details}`;
}

function stressTimeline(start: number, count: number, settled = false): TimelineItem[] {
    const senders = ["Vera", "Sol", "Tamsin", "Rook"];

    return Array.from({ length: count }, (_value, offset) => {
        const index = start + offset;
        const sender = senders[index % senders.length];
        const delayedDecryption = !settled && index % 13 === 0;
        const media =
            index % 17 === 0 || index % 19 === 0
                ? {
                      type: "image" as const,
                      media: {
                          mxcUrl: "/night-receiver-plate.png",
                          mimeType: "image/png",
                          size: 382_000,
                          ...(index % 19 === 0 ? {} : { width: 1024, height: 1024 }),
                      },
                  }
                : {};

        return previewMessage(
            `stress-${index}`,
            sender,
            delayedDecryption ? "" : stressBody(index),
            at(7, 0) + index * 60_000,
            index % 5 === 0,
            { ...media, decryptionState: delayedDecryption ? "decrypting" : "ready" },
        );
    });
}

function createPreviewService(): MatrixService {
    const listeners = new Set<() => void>();
    const previewParams =
        typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    const verificationPreview = previewParams?.get("verification-preview") ?? null;
    const uxPreview = previewParams?.get("ux-preview") ?? null;
    const surfacePreview = previewParams?.get("surface-preview") ?? null;
    const mobilePreview = typeof window !== "undefined" && window.innerWidth <= 720;
    const timelineStressPreview = uxPreview?.startsWith("timeline-stress") ?? false;
    let failNextStressPagination = uxPreview === "timeline-stress-failure";
    let nextStressStart = STRESS_INITIAL_START;
    let localStressSequence = 0;
    let stopTimelineStress: (() => void) | null = null;
    const solMessage = previewMessage(
        "m2",
        "Sol",
        "Copy. I’ll continue the sweep on the north arc and report any anomalies.\n\nLooks like background ion wash. Within margin.",
        at(10, 21),
    );
    const tamsinMessage = previewMessage(
        "m3",
        "Tamsin",
        "Power fluctuation on Relay 7B at 03:17. Nothing persistent.",
        at(10, 24),
    );
    const veraReply = previewMessage(
        "m4",
        "Vera",
        "Thanks. I’ve annotated the spike.",
        at(10, 25),
        false,
        {
            replyTo: "m3",
            replySummary: {
                senderId: "@tamsin:sub-etha.test",
                senderName: "Tamsin",
                body: mobilePreview
                    ? "Power fluctuation on Relay 7B."
                    : "Power fluctuation on Relay 7B at 03:17.",
            },
        },
    );
    const rookMessage = previewMessage(
        "m6",
        "Rook",
        "Did we get the new coil batch manifest? Logistics said it cleared customs.",
        at(10, 31),
    );
    const standardTimeline = [
        ...(mobilePreview ? [] : [solMessage, tamsinMessage]),
        veraReply,
        ...(mobilePreview ? [rookMessage] : []),
        previewMessage("m7", "Vera", "Yes. Dockside locker. Seal intact.", at(10, 33), false, {
            reactions: [{ key: "👍", count: 2, mine: false }],
        }),
        previewMessage(
            "m8",
            "Tamsin",
            "Scheduling maintenance window for 2100.\nI’ll drop the calendar invite.",
            at(10, 42),
            false,
            uxPreview === "states" ? { decryptionState: "decrypting" } : {},
        ),
        previewMessage("m9", "Rayne", "Roger. I’ll review and confirm.", at(10, 43), true),
        ...(uxPreview === "media"
            ? [
                  previewMessage(
                      "m10",
                      "Vera",
                      "Receiver plate recovered from the archive.",
                      at(10, 44),
                      false,
                      {
                          type: "image",
                          media: {
                              mxcUrl: "/night-receiver-plate.png",
                              mimeType: "image/png",
                              size: 382_000,
                              width: 1024,
                              height: 1024,
                          },
                      },
                  ),
              ]
            : []),
    ];
    let snapshot: MatrixSnapshot = {
        connection: uxPreview === "loading" ? "starting" : "ready",
        rooms: [
            previewRoom(
                "signal-watch",
                "Signal Watch",
                "42-B",
                7,
                "Dockside locker. Seal intact.",
                at(10, 42),
                2,
                true,
                "Sweep coordination and carrier anomalies",
                "FIELD OBSERVATIONS · SWEEP OPERATIONS",
            ),
            previewRoom(
                "hab-drift",
                "Hab Drift Crew",
                "17-A",
                5,
                "Sweep complete on the north arc.",
                at(9, 18),
                1,
                true,
            ),
            previewRoom(
                "archive-echoes",
                "Archive — Echoes",
                "08-C",
                12,
                "The old relay notes are indexed.",
                at(8, 7),
                0,
            ),
            previewRoom(
                "observatory",
                "Observatory",
                "29-D",
                3,
                "Clear skies on the western array.",
                at(7, 36),
            ),
            previewRoom(
                "grid-maintenance",
                "Grid Maintenance",
                "11-E",
                9,
                "Coil batch cleared customs.",
                at(6, 51),
            ),
            previewRoom("maris", "Maris", "M", 2, "See you on the far side.", at(5, 48)),
            ...(mobilePreview ? [] : [previewRoom("ilya", "Ilya", "I", 2, "Typing", at(5, 42), 1)]),
            ...(surfacePreview === "invite"
                ? [
                      previewRoom(
                          "observatory-invite",
                          "Observatory",
                          "29-D",
                          5,
                          "Maris invited you.",
                          at(10, 44),
                          0,
                          false,
                          null,
                          undefined,
                          "invite",
                      ),
                  ]
                : []),
        ],
        activeRoomId:
            surfacePreview === "empty" || surfacePreview === "rooms"
                ? null
                : surfacePreview === "invite"
                  ? "observatory-invite"
                  : "signal-watch",
        timeline:
            uxPreview === "loading"
                ? []
                : timelineStressPreview
                  ? stressTimeline(STRESS_INITIAL_START, STRESS_INITIAL_COUNT)
                  : standardTimeline,
        timelineStartIndex: INITIAL_TIMELINE_ITEM_INDEX,
        typingNames: uxPreview === "states" ? ["Sol"] : [],
        loadingHistory: false,
        hasMoreHistory: timelineStressPreview,
        error: null,
        userId: "@rayne:sub-etha.test",
        displayName: "Rayne",
        avatarMxcUrl: surfacePreview === "settings" ? null : "mxc://preview/zen-mark",
        deviceId: "FIELD-GUIDE-01",
        verification: verificationPreview
            ? {
                  transactionId: "PREVIEW-HANDSHAKE-42",
                  direction: verificationPreview === "incoming" ? "incoming" : "outgoing",
                  otherUserId: "@rayne:sub-etha.test",
                  otherDeviceId: "PHONE-7G42",
                  stage:
                      verificationPreview === "incoming" ||
                      verificationPreview === "waiting" ||
                      verificationPreview === "complete"
                          ? verificationPreview
                          : "comparing",
                  emojis:
                      verificationPreview === "comparing"
                          ? [
                                ["🐶", "Dog"],
                                ["🌳", "Tree"],
                                ["🚀", "Rocket"],
                                ["🎸", "Guitar"],
                                ["🌙", "Moon"],
                                ["📕", "Book"],
                                ["🍎", "Apple"],
                            ]
                          : [],
                  message:
                      verificationPreview === "complete"
                          ? "These two Sub-Etha receivers now trust one another."
                          : "Open Sub-Etha on your other device and accept the verification request.",
              }
            : null,
    };

    const emit = () => listeners.forEach((listener) => listener());

    const update = (next: Partial<MatrixSnapshot>) => {
        snapshot = { ...snapshot, ...next };
        emit();
    };

    const startTimelineStress = () => {
        if (!timelineStressPreview || stopTimelineStress) {
            return;
        }

        const mutationTimers = Array.from({ length: 20 }, (_value, round) =>
            window.setTimeout(
                () => {
                    const eventId = `stress-${150 + round}`;

                    (
                        window as typeof window & { __previewTimelineMutationCount?: number }
                    ).__previewTimelineMutationCount = round + 1;
                    update({
                        timeline: snapshot.timeline.map((item) =>
                            item.id === eventId
                                ? {
                                      ...item,
                                      edited: round % 2 === 0,
                                      reactions: [
                                          ...item.reactions,
                                          { key: "📡", count: round + 1, mine: round % 3 === 0 },
                                      ],
                                  }
                                : item,
                        ),
                    });
                },
                320 + round * 55,
            ),
        );
        const timers = [
            ...mutationTimers,
            window.setTimeout(() => {
                update({
                    timeline: snapshot.timeline.map((item) => {
                        if (
                            item.decryptionState !== "decrypting" ||
                            !item.id.startsWith("stress-")
                        ) {
                            return item;
                        }

                        const index = Number.parseInt(item.id.slice("stress-".length), 10);

                        return { ...item, body: stressBody(index), decryptionState: "ready" };
                    }),
                });
            }, 900),
            window.setTimeout(() => {
                update({
                    timeline: snapshot.timeline.map((item) =>
                        item.id === "stress-192"
                            ? {
                                  ...item,
                                  body: `${item.body}\nDelayed receiver plate resolved without Matrix dimensions.`,
                                  type: "image",
                                  media: {
                                      mxcUrl: "/night-receiver-plate.png",
                                      mimeType: "image/png",
                                      size: 382_000,
                                  },
                              }
                            : item,
                    ),
                });
            }, 1_400),
            window.setTimeout(() => {
                update({
                    timeline: [
                        ...snapshot.timeline,
                        previewMessage(
                            "stress-remote-append",
                            "Vera",
                            "Live carrier update: remote append received.",
                            at(11, 1),
                        ),
                    ],
                });
            }, 1_900),
        ];

        stopTimelineStress = () => {
            timers.forEach((timer) => window.clearTimeout(timer));
            stopTimelineStress = null;
        };
    };

    const service = {
        subscribe: (listener: () => void) => {
            listeners.add(listener);

            if (listeners.size === 1) {
                startTimelineStress();
            }

            return () => {
                listeners.delete(listener);

                if (listeners.size === 0) {
                    stopTimelineStress?.();
                }
            };
        },
        getSnapshot: () => snapshot,
        selectRoom: (roomId: string) =>
            update({
                activeRoomId: roomId,
                hasMoreHistory: timelineStressPreview && roomId === "signal-watch",
            }),
        clearError: () => update({ error: null }),
        markRoomRead: async () => undefined,
        paginate: async () => {
            if (
                !timelineStressPreview ||
                snapshot.loadingHistory ||
                !snapshot.hasMoreHistory ||
                nextStressStart <= 0
            ) {
                return;
            }

            const previewWindow = window as typeof window & {
                __previewPaginationRequests?: number;
            };

            previewWindow.__previewPaginationRequests =
                (previewWindow.__previewPaginationRequests ?? 0) + 1;
            update({ loadingHistory: true });
            await new Promise((resolve) => window.setTimeout(resolve, 250));

            if (failNextStressPagination) {
                failNextStressPagination = false;
                update({
                    loadingHistory: false,
                    error: "The earlier transmission index could not be reached. Retry when ready.",
                });

                return;
            }

            const pageStart = Math.max(0, nextStressStart - STRESS_PAGE_SIZE);
            const earlierTimeline = stressTimeline(pageStart, nextStressStart - pageStart, true);

            nextStressStart = pageStart;
            update({
                timeline: [...earlierTimeline, ...snapshot.timeline],
                timelineStartIndex: snapshot.timelineStartIndex - earlierTimeline.length,
                loadingHistory: false,
                hasMoreHistory: nextStressStart > 0,
                error: null,
            });
        },
        toggleReaction: async (eventId: string, key: string) => {
            update({
                timeline: snapshot.timeline.map((item) =>
                    item.id === eventId
                        ? {
                              ...item,
                              reactions: [
                                  ...item.reactions.filter((reaction) => reaction.key !== key),
                                  {
                                      key,
                                      count:
                                          (item.reactions.find((reaction) => reaction.key === key)
                                              ?.count ?? 0) + 1,
                                      mine: true,
                                  },
                              ],
                          }
                        : item,
                ),
            });
        },
        retry: async () => undefined,
        redact: async (eventId: string) =>
            update({
                timeline: snapshot.timeline.map((item) =>
                    item.id === eventId ? { ...item, redacted: true, body: "" } : item,
                ),
            }),
        setTyping: async (typing: boolean) => update({ typingNames: typing ? ["Sol"] : [] }),
        sendText: async (
            body: string,
            options: { replyTo?: string; editEventId?: string } = {},
        ) => {
            if (options.editEventId) {
                update({
                    timeline: snapshot.timeline.map((item) =>
                        item.id === options.editEventId
                            ? { ...item, body, formattedBody: undefined, edited: true }
                            : item,
                    ),
                });

                return;
            }

            localStressSequence += 1;
            const eventId = timelineStressPreview
                ? `stress-local-${localStressSequence}`
                : `m${Date.now()}`;

            update({
                timeline: [
                    ...snapshot.timeline,
                    previewMessage(eventId, "Rayne", body, Date.now(), true, {
                        readBy: timelineStressPreview ? [] : ["Vera"],
                        replyTo: options.replyTo,
                        sendingStatus: timelineStressPreview ? "sending" : null,
                    }),
                ],
            });

            if (!timelineStressPreview) {
                return;
            }

            await new Promise((resolve) => window.setTimeout(resolve, 220));
            update({
                timeline: snapshot.timeline.map((item) =>
                    item.id === eventId ? { ...item, sendingStatus: null, readBy: ["Vera"] } : item,
                ),
            });
        },
        sendFile: async () => undefined,
        getMediaAsset: async (media: MatrixMediaRef) => {
            if (timelineStressPreview) {
                await new Promise((resolve) => window.setTimeout(resolve, 350));
            }

            return {
                url:
                    media.mxcUrl === "mxc://preview/zen-mark"
                        ? "/icon-512.png"
                        : media.mxcUrl.startsWith("mxc://preview/")
                          ? "/night-receiver-plate.png"
                          : media.mxcUrl,
                blob: new Blob(),
                mimeType: media.mimeType ?? "application/octet-stream",
                animated: media.mimeType === "image/gif",
            };
        },
        getGifPoster: async () => null,
        invalidateMedia: () => undefined,
        createRoom: async () => undefined,
        joinRoom: async (roomId: string) => update({ activeRoomId: roomId }),
        leaveActiveRoom: async () => update({ activeRoomId: null }),
        searchCurrentRoom: async (term: string) =>
            snapshot.timeline.filter((item) =>
                item.body.toLowerCase().includes(term.toLowerCase()),
            ),
        invite: async () => undefined,
        setRoomMuted: async (muted: boolean) =>
            update({
                rooms: snapshot.rooms.map((room) =>
                    room.id === snapshot.activeRoomId ? { ...room, muted } : room,
                ),
            }),
        getDevices: async () => [
            {
                deviceId: snapshot.deviceId,
                displayName: "Sub-Etha field receiver",
                current: true,
                verified: true,
            },
        ],
        getCryptoStatus: async () => ({
            secretStorageReady: true,
            crossSigningReady: true,
            backupVersion: "1",
        }),
        updateProfile: async (displayName: string) => update({ displayName }),
        setupRecovery: async () => "DEMO RECOVERY KEY",
        unlockRecovery: async () => undefined,
        startDeviceVerification: async () =>
            update({
                verification: {
                    transactionId: "PREVIEW-HANDSHAKE-42",
                    direction: "outgoing",
                    otherUserId: snapshot.userId,
                    otherDeviceId: "PHONE-7G42",
                    stage: "waiting",
                    emojis: [],
                    message:
                        "Open Sub-Etha on your other device and accept the verification request.",
                },
            }),
        acceptDeviceVerification: async () =>
            update({
                verification: {
                    transactionId: "PREVIEW-HANDSHAKE-42",
                    direction: "incoming",
                    otherUserId: snapshot.userId,
                    otherDeviceId: "PHONE-7G42",
                    stage: "comparing",
                    emojis: [
                        ["🐶", "Dog"],
                        ["🌳", "Tree"],
                        ["🚀", "Rocket"],
                        ["🎸", "Guitar"],
                        ["🌙", "Moon"],
                        ["📕", "Book"],
                        ["🍎", "Apple"],
                    ],
                },
            }),
        confirmDeviceVerification: async (matches: boolean) =>
            update({
                verification: {
                    transactionId: "PREVIEW-HANDSHAKE-42",
                    direction: "outgoing",
                    otherUserId: snapshot.userId,
                    otherDeviceId: "PHONE-7G42",
                    stage: matches ? "complete" : "cancelled",
                    emojis: [],
                    message: matches
                        ? "These two Sub-Etha receivers now trust one another."
                        : "The emoji did not match, so verification was safely cancelled.",
                },
            }),
        cancelDeviceVerification: async () =>
            update({
                verification: {
                    transactionId: "PREVIEW-HANDSHAKE-42",
                    direction: "outgoing",
                    otherUserId: snapshot.userId,
                    otherDeviceId: "PHONE-7G42",
                    stage: "cancelled",
                    emojis: [],
                    message: "Verification cancelled.",
                },
            }),
        dismissDeviceVerification: () => update({ verification: null }),
        logout: async () => undefined,
    };

    return service as unknown as MatrixService;
}

export function DesignPreview() {
    const [service] = useState(createPreviewService);
    const searchParams =
        typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
    const surfacePreview = searchParams?.get("surface-preview") ?? null;
    /*
     * The reference document carries the same design in two palettes, so the
     * preview pins whichever one is being checked. Dark stays the default so
     * existing captures are unaffected.
     */
    const requestedTheme = searchParams?.get("theme");
    const previewTheme =
        requestedTheme === "light" || requestedTheme === "system" ? requestedTheme : "dark";

    useEffect(() => {
        const previousTheme = document.documentElement.dataset.theme;

        document.documentElement.dataset.theme = previewTheme;

        return () => {
            if (previousTheme) {
                document.documentElement.dataset.theme = previousTheme;
            } else {
                document.documentElement.removeAttribute("data-theme");
            }
        };
    }, [previewTheme]);

    if (surfacePreview === "login") {
        return <LoginScreen onAuthenticated={async () => undefined} />;
    }

    if (surfacePreview === "settings") {
        return (
            <ChatShell
                service={service}
                onLogout={async () => undefined}
                initialDialog="settings"
            />
        );
    }

    return <ChatShell service={service} onLogout={async () => undefined} />;
}
