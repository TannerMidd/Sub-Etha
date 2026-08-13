"use client";

import {
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useDeferredValue,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import {
    ArrowLeft,
    ArrowRight,
    BellOff,
    Check,
    Info,
    LockKeyhole,
    Search,
    Settings,
    Signal,
    SignalLow,
    Users,
    WifiOff,
    X,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import {
    canStartMobileSwipe,
    guideEntryCode,
    resolveMobileSwipe,
    shouldDeferRoomHistorySeed,
} from "@/lib/guide-navigation";
import {
    dismissRoomNotification,
    syncAppBadge,
    totalUnreadCount,
} from "@/lib/matrix/notifications";
import type { RoomSummary, TimelineItem } from "@/lib/matrix/types";
import { Avatar } from "./BrandMark";
import { Composer, type ComposerHandle } from "./Composer";
import {
    NewConversationDialog,
    RoomDetailsDialog,
    SearchDialog,
    SettingsDialog,
    VerificationDialog,
} from "./Panels";
import { Timeline } from "./Timeline";
import { classes } from "../styles/appStyles";

type OpenDialog = "new" | "search" | "settings" | "details" | null;
type RoomScope = "all" | "unread";
type MobileFocusTarget = "conversation-heading" | "index-button" | null;

interface SubEthaHistoryState {
    subEthaView?: "rooms" | "room";
    roomId?: string;
    roomsBehind?: boolean;
    [key: string]: unknown;
}

interface SwipeStart {
    pointerId: number;
    x: number;
    y: number;
    startedAt: number;
}

function roomUrl(roomId: string): string {
    return `${window.location.pathname}${window.location.search}#/room/${encodeURIComponent(roomId)}`;
}

function roomIndexUrl(): string {
    return `${window.location.pathname}${window.location.search}`;
}

function isMobileLayout(): boolean {
    return window.matchMedia("(max-width: 720px)").matches;
}

function blocksSwipeNavigation(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
        return true;
    }

    if (
        target.closest(
            'button, a, input, textarea, select, [contenteditable="true"], [role="slider"], video, audio, iframe, [aria-modal="true"], [data-swipe-lock]',
        )
    ) {
        return true;
    }

    let current: Element | null = target;

    while (current && current !== document.body) {
        const style = window.getComputedStyle(current);

        if (
            current.scrollWidth > current.clientWidth + 1 &&
            (style.overflowX === "auto" || style.overflowX === "scroll")
        ) {
            return true;
        }

        current = current.parentElement;
    }

    return false;
}

export function parseRoomHash(hash = window.location.hash): string | null {
    const match = hash.match(/^#\/room\/([^/]+)/);

    if (!match) {
        return null;
    }

    try {
        return decodeURIComponent(match[1]);
    } catch {
        return null;
    }
}

function ConnectionPill({
    state,
}: {
    state: ReturnType<MatrixService["getSnapshot"]>["connection"];
}) {
    if (state === "ready") {
        return (
            <span className={classes("connection-pill connection-pill--ready")}>
                <Signal />
                Connected
            </span>
        );
    }

    if (state === "offline") {
        return (
            <span className={classes("connection-pill connection-pill--offline")}>
                <WifiOff />
                Offline
            </span>
        );
    }

    if (state === "error") {
        return (
            <span className={classes("connection-pill connection-pill--error")}>
                <SignalLow />
                Signal trouble
            </span>
        );
    }

    return (
        <span className={classes("connection-pill")}>
            <SignalLow />
            {state === "catching-up" ? "Catching up" : "Tuning"}
        </span>
    );
}

function RoomListItem({
    room,
    active,
    accented = active,
    onClick,
}: {
    room: RoomSummary;
    active: boolean;
    accented?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            className={classes(
                `room-list-item${accented ? " is-active" : ""}${
                    room.unread || room.highlights ? " has-unread" : ""
                }${room.membership === "invite" ? " is-invite" : ""}`,
            )}
            type="button"
            onClick={onClick}
            aria-current={active ? "page" : undefined}
        >
            <span className={classes("room-list-item__index")} aria-hidden="true">
                {room.guideCode ?? guideEntryCode(room.id)}
            </span>
            <span className={classes("room-list-item__copy")}>
                <span>
                    <strong>{room.name}</strong>
                    {room.encrypted ? <LockKeyhole aria-label="Encrypted" /> : null}
                </span>
                <small>
                    {room.membership === "invite"
                        ? "Invitation waiting"
                        : room.lastMessage || "No recent transmissions"}
                </small>
            </span>
            <span className={classes("room-list-item__meta")}>
                {room.timestamp ? (
                    <time>
                        {new Intl.DateTimeFormat(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                            hourCycle: "h23",
                        }).format(room.timestamp)}
                    </time>
                ) : null}
                {room.unread ? (
                    <span
                        className={classes(room.highlights ? "highlight-badge" : "unread-dot")}
                        aria-label={`${room.unread} unread`}
                    >
                        {room.unread > 99 ? "99+" : room.unread}
                    </span>
                ) : null}
            </span>
        </button>
    );
}

function inviteSenderName(room: RoomSummary, ownUserId: string): string | null {
    const inviterId = room.room?.getMember?.(ownUserId)?.events.member?.getSender();

    if (!inviterId || inviterId === ownUserId) {
        return room.lastMessage.match(/^(.+?)\s+invited you\b/i)?.[1]?.trim() ?? null;
    }

    const memberName = room.room.getMember?.(inviterId)?.name?.trim();

    if (memberName) {
        return memberName;
    }

    return inviterId.match(/^@([^:]+)/)?.[1] ?? inviterId;
}

function roomAudience(room: RoomSummary, spellSmallCount = false): string {
    const smallCountWords = [
        "Zero",
        "One",
        "Two",
        "Three",
        "Four",
        "Five",
        "Six",
        "Seven",
        "Eight",
        "Nine",
        "Ten",
    ];
    const count =
        spellSmallCount && room.memberCount <= 10
            ? smallCountWords[room.memberCount]
            : String(room.memberCount);
    const people = `${count} ${room.memberCount === 1 ? "person" : "people"}`;

    return `${people} · ${room.encrypted ? "private" : "open"}`;
}

function displayMatrixAddress(userId: string): string {
    const match = userId.match(/^@([^:]+):(.+)$/);

    return match ? `${match[1]}@${match[2]}` : userId;
}

export function ChatShell({
    service,
    onLogout,
    initialDialog = null,
}: {
    service: MatrixService;
    onLogout: () => Promise<void>;
    initialDialog?: OpenDialog;
}) {
    const snapshot = useSyncExternalStore(
        service.subscribe,
        service.getSnapshot,
        service.getSnapshot,
    );
    const [roomFilter, setRoomFilter] = useState("");
    const [roomScope, setRoomScope] = useState<RoomScope>("all");
    const deferredFilter = useDeferredValue(roomFilter);
    const [dialog, setDialog] = useState<OpenDialog>(initialDialog);
    const [replyingTo, setReplyingTo] = useState<TimelineItem | null>(null);
    const [editing, setEditing] = useState<TimelineItem | null>(null);
    const [mobileRoomsOpen, setMobileRoomsOpen] = useState(!snapshot.activeRoomId);
    const roomSearchInput = useRef<HTMLInputElement>(null);
    const mobileMenuButton = useRef<HTMLButtonElement>(null);
    const conversationHeading = useRef<HTMLHeadingElement>(null);
    const composer = useRef<ComposerHandle>(null);
    const mobileFocusTarget = useRef<MobileFocusTarget>(null);
    const mobileRoomsWasOpen = useRef(mobileRoomsOpen);
    const swipeStart = useRef<SwipeStart | null>(null);
    const suppressSwipeClickUntil = useRef(0);
    const historySeeded = useRef(false);
    const activeRoom = snapshot.rooms.find((room) => room.id === snapshot.activeRoomId) ?? null;
    const activeEntryCode = activeRoom
        ? (activeRoom.guideCode ?? guideEntryCode(activeRoom.id))
        : null;
    const activeInviteSender =
        activeRoom?.membership === "invite" ? inviteSenderName(activeRoom, snapshot.userId) : null;

    const showRoomIndex = useCallback(() => {
        if (!isMobileLayout()) {
            return;
        }

        const state = (window.history.state ?? {}) as SubEthaHistoryState;

        setMobileRoomsOpen(true);

        if (state.subEthaView === "room" && state.roomsBehind && historySeeded.current) {
            window.history.back();

            return;
        }

        window.history.pushState(
            { ...state, subEthaView: "rooms", roomId: undefined },
            "",
            roomIndexUrl(),
        );
        historySeeded.current = true;
    }, []);

    const closeRoomIndex = useCallback(() => {
        const current = service.getSnapshot();
        const room = current.rooms.find((candidate) => candidate.id === current.activeRoomId);

        if (!room) {
            return;
        }

        const state = (window.history.state ?? {}) as SubEthaHistoryState;

        window.history.pushState(
            { ...state, subEthaView: "room", roomId: room.id, roomsBehind: true },
            "",
            roomUrl(room.id),
        );
        historySeeded.current = true;
        mobileFocusTarget.current = "index-button";
        setMobileRoomsOpen(false);
    }, [service]);

    const filteredRooms = useMemo(() => {
        const query = deferredFilter.trim().toLowerCase();
        const matching = query
            ? snapshot.rooms.filter((room) =>
                  `${room.name} ${room.lastMessage}`.toLowerCase().includes(query),
              )
            : snapshot.rooms;

        if (roomScope === "unread") {
            return matching.filter((room) => room.unread || room.highlights);
        }

        return matching;
    }, [deferredFilter, roomScope, snapshot.rooms]);

    const invitations = filteredRooms.filter((room) => room.membership === "invite");
    const joinedRooms = filteredRooms.filter(
        (room) => room.membership !== "invite" && room.memberCount > 2,
    );
    const directMessages = filteredRooms.filter(
        (room) => room.membership !== "invite" && room.memberCount <= 2,
    );
    const unreadTotal = totalUnreadCount(snapshot.rooms);

    useEffect(() => {
        void syncAppBadge(unreadTotal);
    }, [unreadTotal]);

    useEffect(() => {
        const acknowledgeActiveRoom = () => {
            const roomId = service.getSnapshot().activeRoomId;

            if (!roomId || document.visibilityState !== "visible") {
                return;
            }

            void service.markRoomRead(roomId);
            void dismissRoomNotification(roomId);
        };

        acknowledgeActiveRoom();
        document.addEventListener("visibilitychange", acknowledgeActiveRoom);
        window.addEventListener("focus", acknowledgeActiveRoom);

        return () => {
            document.removeEventListener("visibilitychange", acknowledgeActiveRoom);
            window.removeEventListener("focus", acknowledgeActiveRoom);
        };
    }, [service, snapshot.activeRoomId]);

    useEffect(() => {
        if (!isMobileLayout() || !activeRoom || historySeeded.current) {
            return;
        }

        const routedRoomId = parseRoomHash();

        if (
            shouldDeferRoomHistorySeed(
                activeRoom.id,
                routedRoomId,
                snapshot.rooms.map((room) => room.id),
            )
        ) {
            return;
        }

        const state = (window.history.state ?? {}) as SubEthaHistoryState;

        if (state.subEthaView === "room" || state.subEthaView === "rooms") {
            historySeeded.current = true;

            return;
        }

        const currentRoomUrl =
            routedRoomId === activeRoom.id
                ? `${window.location.pathname}${window.location.search}${window.location.hash}`
                : roomUrl(activeRoom.id);

        window.history.replaceState(
            { ...state, subEthaView: "rooms", roomId: undefined, roomsBehind: undefined },
            "",
            roomIndexUrl(),
        );
        window.history.pushState(
            { ...state, subEthaView: "room", roomId: activeRoom.id, roomsBehind: true },
            "",
            currentRoomUrl,
        );
        historySeeded.current = true;
    }, [activeRoom, snapshot.rooms]);

    useEffect(() => {
        const selectFromLocation = () => {
            const roomId = parseRoomHash();
            const mobile = isMobileLayout();

            if (
                roomId &&
                snapshot.rooms.some((room) => room.id === roomId) &&
                roomId !== service.getSnapshot().activeRoomId
            ) {
                if (mobile) {
                    mobileFocusTarget.current = "conversation-heading";
                }

                service.selectRoom(roomId);
                setMobileRoomsOpen(false);

                return;
            }

            if (!roomId && mobile) {
                setMobileRoomsOpen(true);
            } else if (roomId) {
                if (mobile && mobileRoomsOpen) {
                    mobileFocusTarget.current = "conversation-heading";
                }

                setMobileRoomsOpen(false);
            }
        };

        selectFromLocation();
        window.addEventListener("hashchange", selectFromLocation);
        window.addEventListener("popstate", selectFromLocation);

        return () => {
            window.removeEventListener("hashchange", selectFromLocation);
            window.removeEventListener("popstate", selectFromLocation);
        };
    }, [mobileRoomsOpen, service, snapshot.rooms]);

    useEffect(() => {
        if (!activeRoom || mobileRoomsOpen || !historySeeded.current) {
            return;
        }

        const state = (window.history.state ?? {}) as SubEthaHistoryState;
        const routedRoomId = parseRoomHash();
        const nextState = {
            ...state,
            subEthaView: "room" as const,
            roomId: activeRoom.id,
            roomsBehind: state.roomsBehind ?? false,
        };

        if (routedRoomId === activeRoom.id) {
            if (state.subEthaView !== "room" || state.roomId !== activeRoom.id) {
                window.history.replaceState(nextState, "", window.location.href);
            }

            return;
        }

        window.history.replaceState(nextState, "", roomUrl(activeRoom.id));
    }, [activeRoom, mobileRoomsOpen]);

    useEffect(() => {
        const shortcut = (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                window.requestAnimationFrame(() => roomSearchInput.current?.focus());
            } else if (event.key === "Escape" && mobileRoomsOpen && isMobileLayout()) {
                event.preventDefault();
                closeRoomIndex();
            }
        };

        window.addEventListener("keydown", shortcut);

        return () => window.removeEventListener("keydown", shortcut);
    }, [closeRoomIndex, mobileRoomsOpen]);

    useEffect(() => {
        const wasOpen = mobileRoomsWasOpen.current;

        mobileRoomsWasOpen.current = mobileRoomsOpen;

        if (!isMobileLayout()) {
            return;
        }

        const requestedTarget = mobileFocusTarget.current;
        const focusTarget = mobileRoomsOpen
            ? roomSearchInput.current
            : requestedTarget === "conversation-heading"
              ? conversationHeading.current
              : wasOpen && requestedTarget === "index-button"
                ? mobileMenuButton.current
                : null;

        if (!focusTarget) {
            return;
        }

        if (!mobileRoomsOpen) {
            mobileFocusTarget.current = null;
        }

        const frame = window.requestAnimationFrame(() =>
            focusTarget.focus({ preventScroll: true }),
        );

        return () => window.cancelAnimationFrame(frame);
    }, [mobileRoomsOpen, snapshot.activeRoomId]);

    const selectRoom = (roomId: string) => {
        const mobile = isMobileLayout();

        if (mobile) {
            mobileFocusTarget.current = "conversation-heading";
        }

        service.selectRoom(roomId);
        let state = (window.history.state ?? {}) as SubEthaHistoryState;

        if (mobile && mobileRoomsOpen && state.subEthaView !== "rooms") {
            state = {
                ...state,
                subEthaView: "rooms",
                roomId: undefined,
                roomsBehind: undefined,
            };
            window.history.replaceState(state, "", roomIndexUrl());
        }

        window.history.pushState(
            {
                ...state,
                subEthaView: "room",
                roomId,
                roomsBehind: mobile && mobileRoomsOpen,
            },
            "",
            roomUrl(roomId),
        );
        historySeeded.current = mobile;
        setMobileRoomsOpen(false);
        setReplyingTo(null);
        setEditing(null);
    };

    const beginSwipe = (event: ReactPointerEvent<HTMLElement>) => {
        if (
            event.pointerType === "mouse" ||
            !event.isPrimary ||
            event.button !== 0 ||
            dialog ||
            snapshot.verification ||
            !isMobileLayout() ||
            blocksSwipeNavigation(event.target) ||
            !canStartMobileSwipe(event.clientX, mobileRoomsOpen)
        ) {
            return;
        }

        swipeStart.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            startedAt: performance.now(),
        };
        event.currentTarget.setPointerCapture(event.pointerId);
    };

    const finishSwipe = (event: ReactPointerEvent<HTMLElement>) => {
        const start = swipeStart.current;

        if (!start || start.pointerId !== event.pointerId) {
            return;
        }

        swipeStart.current = null;

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }

        const action = resolveMobileSwipe({
            startX: start.x,
            endX: event.clientX,
            startY: start.y,
            endY: event.clientY,
            elapsedMs: performance.now() - start.startedAt,
            viewportWidth: window.innerWidth,
            indexOpen: mobileRoomsOpen,
        });

        if (action === "open-index") {
            event.preventDefault();
            suppressSwipeClickUntil.current = performance.now() + 500;
            showRoomIndex();
        } else if (action === "close-index") {
            event.preventDefault();
            suppressSwipeClickUntil.current = performance.now() + 500;
            closeRoomIndex();
        }
    };

    const cancelSwipe = (event: ReactPointerEvent<HTMLElement>) => {
        if (swipeStart.current?.pointerId === event.pointerId) {
            swipeStart.current = null;
        }
    };

    const roomGroup = (
        title: string,
        rooms: RoomSummary[],
        countLabel: string | number = rooms.length,
    ) => {
        if (!rooms.length) {
            return null;
        }

        const groupSlug = title.toLowerCase().replace(/\s+/g, "-");
        const groupId = `room-group-${groupSlug}`;

        return (
            <section
                className={classes(`room-group room-group--${groupSlug}`)}
                aria-labelledby={groupId}
            >
                <h2 id={groupId}>
                    {title}
                    <span>{countLabel}</span>
                </h2>
                {rooms.map((room) => (
                    <RoomListItem
                        key={room.id}
                        room={room}
                        active={room.id === snapshot.activeRoomId}
                        accented={
                            room.id === snapshot.activeRoomId ||
                            (!snapshot.activeRoomId && title === "Rooms" && room === rooms[0])
                        }
                        onClick={() => selectRoom(room.id)}
                    />
                ))}
            </section>
        );
    };

    return (
        <main
            className={classes(`app-shell${mobileRoomsOpen ? " mobile-rooms-open" : ""}`)}
            data-ui="app-shell"
            data-rooms-state={mobileRoomsOpen ? "open" : "closed"}
            onPointerDown={beginSwipe}
            onPointerUp={finishSwipe}
            onPointerCancel={cancelSwipe}
            onClickCapture={(event) => {
                if (performance.now() < suppressSwipeClickUntil.current) {
                    suppressSwipeClickUntil.current = 0;
                    event.preventDefault();
                    event.stopPropagation();
                }
            }}
        >
            <aside className={classes("room-sidebar")} data-ui="room-sidebar" aria-label="Rooms">
                <header className={classes("room-sidebar__header")}>
                    <span className={classes("room-sidebar__wordmark")} aria-label="Sub-Etha">
                        SUB—ETHA
                    </span>
                    <button
                        className={classes("room-sidebar__new")}
                        type="button"
                        aria-label="New conversation"
                        onClick={() => setDialog("new")}
                    >
                        New
                    </button>
                    <button
                        className={classes("room-sidebar__close")}
                        type="button"
                        aria-label="Return to the active room"
                        onClick={closeRoomIndex}
                    >
                        <span>Room</span>
                        <ArrowRight />
                    </button>
                </header>
                <div className={classes("room-sidebar__body")}>
                    <div className={classes("room-column")}>
                        <div className={classes("transmission-search")}>
                            <label className={classes("sr-only")} htmlFor="transmission-search">
                                Search rooms
                            </label>
                            <input
                                ref={roomSearchInput}
                                id="transmission-search"
                                value={roomFilter}
                                onChange={(event) => setRoomFilter(event.target.value)}
                                placeholder="Search"
                            />
                        </div>
                        <div className={classes("room-column__header")}>
                            <span>
                                <strong>Index of transmissions</strong>
                                <small>
                                    {filteredRooms.length}{" "}
                                    {filteredRooms.length === 1 ? "entry" : "entries"}
                                </small>
                            </span>
                        </div>
                        <nav className={classes("room-scope-tabs")} aria-label="Room views">
                            {(
                                [
                                    { id: "all", label: "All" },
                                    { id: "unread", label: "Unread" },
                                ] as const
                            ).map((item) => (
                                <button
                                    key={item.id}
                                    className={classes(roomScope === item.id ? "is-active" : "")}
                                    type="button"
                                    aria-pressed={roomScope === item.id}
                                    aria-label={
                                        item.id === "unread" && unreadTotal
                                            ? `Unread, ${unreadTotal}`
                                            : item.label
                                    }
                                    onClick={() => setRoomScope(item.id)}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </nav>
                        <nav className={classes("room-list")} aria-label="Your Matrix rooms">
                            {roomGroup("Invitations", invitations)}
                            {roomGroup(
                                "Rooms",
                                joinedRooms,
                                `${joinedRooms.length + directMessages.length} tuned`,
                            )}
                            {roomGroup("Direct", directMessages, "")}
                            {!filteredRooms.length ? (
                                <div className={classes("room-list-empty")}>
                                    <Search />
                                    <strong>No rooms found</strong>
                                    <span>The index is being uncharacteristically decisive.</span>
                                </div>
                            ) : null}
                        </nav>
                        <footer className={classes("profile-strip")}>
                            <Avatar
                                name={snapshot.displayName}
                                mxcUrl={snapshot.avatarMxcUrl}
                                service={service}
                            />
                            <button
                                className={classes("profile-strip__identity")}
                                type="button"
                                aria-label={`${snapshot.displayName}, ${snapshot.userId}`}
                                title={snapshot.userId}
                                onClick={() => setDialog("settings")}
                            >
                                <span>
                                    <strong>{snapshot.displayName}</strong>
                                    <small>{displayMatrixAddress(snapshot.userId)}</small>
                                </span>
                            </button>
                            <button
                                className={classes("profile-strip__settings")}
                                type="button"
                                aria-label="Settings"
                                onClick={() => setDialog("settings")}
                            >
                                <Settings />
                                <span>Settings</span>
                            </button>
                        </footer>
                    </div>
                </div>
            </aside>

            <section
                className={classes(
                    `conversation${!activeRoom || activeRoom.membership === "invite" ? " conversation--single" : ""}`,
                )}
                aria-label={activeRoom ? activeRoom.name : "No room selected"}
                aria-hidden={(mobileRoomsOpen && !!activeRoom) || undefined}
                inert={(mobileRoomsOpen && !!activeRoom) || undefined}
            >
                {activeRoom ? (
                    <>
                        <div className={classes("conversation-main")} key={activeRoom.id}>
                            <header
                                className={classes("conversation-header")}
                                data-ui="conversation-header"
                            >
                                <button
                                    ref={mobileMenuButton}
                                    className={classes("mobile-menu-button")}
                                    type="button"
                                    aria-label="Open transmission index"
                                    onClick={showRoomIndex}
                                >
                                    <ArrowLeft />
                                    <span>Index</span>
                                </button>
                                <div className={classes("conversation-header__title")}>
                                    <span className={classes("conversation-entry")}>
                                        Entry {activeEntryCode}
                                    </span>
                                    <h1 ref={conversationHeading} tabIndex={-1}>
                                        {activeRoom.name}
                                        {activeRoom.muted ? <BellOff aria-label="Muted" /> : null}
                                    </h1>
                                    <p>
                                        <span className={classes("room-presence-summary")}>
                                            {roomAudience(activeRoom)}
                                        </span>
                                        <span className={classes("room-classification")}>
                                            Classification:{" "}
                                            {activeRoom.classification ??
                                                (activeRoom.memberCount <= 2
                                                    ? "Direct transmission"
                                                    : "Field observations")}
                                        </span>
                                        <span className={classes("room-privacy-state")}>
                                            {activeRoom.encrypted ? <LockKeyhole /> : null}
                                            {activeRoom.encrypted
                                                ? "Private end to end"
                                                : "Unencrypted"}
                                        </span>
                                        <span
                                            className={classes(
                                                `room-live-state room-live-state--${snapshot.connection}`,
                                            )}
                                        >
                                            <i aria-hidden="true" />
                                            {snapshot.connection === "ready"
                                                ? "Online"
                                                : snapshot.connection === "offline"
                                                  ? "Offline"
                                                  : "Tuning"}
                                        </span>
                                    </p>
                                </div>
                                <div className={classes("conversation-commands")}>
                                    <button
                                        type="button"
                                        aria-label="Search this room"
                                        onClick={() => setDialog("search")}
                                    >
                                        <Search />
                                        <span>Search</span>
                                    </button>
                                    <button
                                        type="button"
                                        aria-label="Room details"
                                        onClick={() => setDialog("details")}
                                    >
                                        <Info />
                                        <span>Details</span>
                                    </button>
                                </div>
                            </header>
                            {activeRoom.membership === "invite" ? (
                                <div className={classes("invite-view")}>
                                    <div className={classes("invite-card")}>
                                        <span className={classes("index-chip")}>Invitation</span>
                                        <Avatar
                                            name={activeRoom.name}
                                            mxcUrl={activeRoom.avatarMxcUrl}
                                            service={service}
                                            size="large"
                                        />
                                        <h2>
                                            {activeInviteSender
                                                ? `${activeInviteSender} invited you to ${activeRoom.name}.`
                                                : `You were invited to ${activeRoom.name}.`}
                                        </h2>
                                        <p>{roomAudience(activeRoom, true)}</p>
                                        <div>
                                            <button
                                                className={classes("primary-button")}
                                                type="button"
                                                onClick={() => void service.joinRoom(activeRoom.id)}
                                            >
                                                <Check />
                                                Accept
                                            </button>
                                            <button
                                                className={classes("secondary-button")}
                                                type="button"
                                                onClick={() => void service.leaveActiveRoom()}
                                            >
                                                <X />
                                                Decline
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div
                                        className={classes("conversation-stage")}
                                        data-ui="conversation-stage"
                                    >
                                        <Timeline
                                            key={activeRoom.id}
                                            items={snapshot.timeline}
                                            firstItemIndex={snapshot.timelineStartIndex}
                                            service={service}
                                            loadingHistory={snapshot.loadingHistory}
                                            hasMoreHistory={snapshot.hasMoreHistory}
                                            initializing={snapshot.connection === "starting"}
                                            unreadCount={activeRoom.unread}
                                            onReply={(item) => {
                                                if (isMobileLayout()) {
                                                    flushSync(() => {
                                                        setReplyingTo(item);
                                                        setEditing(null);
                                                    });
                                                    composer.current?.focus();

                                                    return;
                                                }

                                                setReplyingTo(item);
                                                setEditing(null);
                                            }}
                                            onEdit={(item) => {
                                                setEditing(item);
                                                setReplyingTo(null);
                                            }}
                                        />
                                    </div>
                                    <div
                                        className={classes(
                                            `typing-line${snapshot.typingNames.length ? " is-active" : ""}`,
                                        )}
                                        data-ui="typing-line"
                                        data-active={snapshot.typingNames.length > 0}
                                        aria-live="polite"
                                        aria-atomic="true"
                                    >
                                        {snapshot.typingNames.length ? (
                                            <>
                                                <span
                                                    className={classes("typing-dots")}
                                                    aria-hidden="true"
                                                >
                                                    <i />
                                                    <i />
                                                    <i />
                                                </span>
                                                <span>
                                                    {snapshot.typingNames.join(", ")}{" "}
                                                    {snapshot.typingNames.length === 1
                                                        ? "is"
                                                        : "are"}{" "}
                                                    typing…
                                                </span>
                                            </>
                                        ) : null}
                                    </div>
                                    <Composer
                                        ref={composer}
                                        key={`${activeRoom.id}:${editing?.id ?? "compose"}`}
                                        roomId={activeRoom.id}
                                        roomName={activeRoom.name}
                                        service={service}
                                        replyingTo={replyingTo}
                                        editing={editing}
                                        onClearContext={() => {
                                            setReplyingTo(null);
                                            setEditing(null);
                                        }}
                                    />
                                    <footer
                                        className={classes("receiver-status")}
                                        aria-label="Receiver status"
                                    >
                                        <ConnectionPill state={snapshot.connection} />
                                        <span>
                                            <LockKeyhole />
                                            <strong>Encryption</strong>
                                            <span
                                                className={classes("receiver-status__desktop-copy")}
                                            >
                                                {activeRoom.encrypted
                                                    ? "End-to-end"
                                                    : "Not encrypted"}
                                            </span>
                                            <span
                                                className={classes("receiver-status__mobile-copy")}
                                            >
                                                {activeRoom.encrypted
                                                    ? "End to end private"
                                                    : "Not encrypted"}
                                            </span>
                                        </span>
                                        <button type="button" onClick={() => setDialog("details")}>
                                            <Users />
                                            <strong>{activeRoom.memberCount}</strong>
                                            <span
                                                className={classes("receiver-status__desktop-copy")}
                                            >
                                                {activeRoom.memberCount === 1
                                                    ? "member"
                                                    : "members"}
                                            </span>
                                        </button>
                                    </footer>
                                </>
                            )}
                        </div>
                    </>
                ) : (
                    <div className={classes("no-room-view")}>
                        <div className={classes("guide-card")}>
                            <span className={classes("guide-card__number")}>01</span>
                            <p className={classes("eyebrow")}>No room selected</p>
                            <h1>Nothing selected.</h1>
                            <p>Choose a room on the left, or start something new.</p>
                            <button
                                className={classes("secondary-button")}
                                type="button"
                                onClick={() => setDialog("new")}
                            >
                                New conversation
                            </button>
                        </div>
                    </div>
                )}
            </section>

            <button
                className={classes("sidebar-scrim")}
                data-ui="sidebar-scrim"
                type="button"
                aria-label="Close room list"
                onClick={closeRoomIndex}
            />
            {snapshot.error ? (
                <div className={classes("app-toast")} role="alert">
                    <SignalLow />
                    <span>{snapshot.error}</span>
                    <button type="button" aria-label="Dismiss" onClick={() => service.clearError()}>
                        <X />
                    </button>
                </div>
            ) : null}
            {dialog === "new" ? (
                <NewConversationDialog service={service} onClose={() => setDialog(null)} />
            ) : null}
            {dialog === "search" ? (
                <SearchDialog service={service} onClose={() => setDialog(null)} />
            ) : null}
            {dialog === "settings" ? (
                <SettingsDialog
                    service={service}
                    onClose={() => setDialog(null)}
                    onLogout={onLogout}
                    onVerificationStarted={() => setDialog(null)}
                />
            ) : null}
            {dialog === "details" && activeRoom ? (
                <RoomDetailsDialog
                    room={activeRoom}
                    service={service}
                    onClose={() => setDialog(null)}
                />
            ) : null}
            {snapshot.verification ? (
                <VerificationDialog verification={snapshot.verification} service={service} />
            ) : null}
        </main>
    );
}
