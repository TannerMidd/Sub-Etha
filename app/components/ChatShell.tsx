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
import {
    ArrowLeft,
    ArrowRight,
    BellOff,
    Check,
    Crosshair,
    Info,
    LockKeyhole,
    MessageSquarePlus,
    Search,
    Settings,
    Signal,
    SignalLow,
    Star,
    UserPlus,
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
import { Avatar, BrandMark } from "./BrandMark";
import { Composer } from "./Composer";
import {
    NewConversationDialog,
    RoomDetailsDialog,
    SearchDialog,
    SettingsDialog,
    VerificationDialog,
} from "./Panels";
import { Timeline } from "./Timeline";

type OpenDialog = "new" | "search" | "settings" | "details" | null;
type RoomScope = "all" | "unread" | "favourites" | "invitations";

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
            'button, a, input, textarea, select, [contenteditable="true"], [role="slider"], video, audio, iframe, [aria-modal="true"], .emoji-popover, .reaction-picker, [data-swipe-lock]',
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
            <span className="connection-pill connection-pill--ready">
                <Signal />
                Connected
            </span>
        );
    }

    if (state === "offline") {
        return (
            <span className="connection-pill connection-pill--offline">
                <WifiOff />
                Offline
            </span>
        );
    }

    if (state === "error") {
        return (
            <span className="connection-pill connection-pill--error">
                <SignalLow />
                Signal trouble
            </span>
        );
    }

    return (
        <span className="connection-pill">
            <SignalLow />
            {state === "catching-up" ? "Catching up" : "Tuning"}
        </span>
    );
}

function RoomListItem({
    room,
    active,
    onClick,
}: {
    room: RoomSummary;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            className={`room-list-item${active ? " is-active" : ""}`}
            type="button"
            onClick={onClick}
            aria-current={active ? "page" : undefined}
        >
            <span className="room-list-item__index" aria-hidden="true">
                {room.guideCode ?? guideEntryCode(room.id)}
            </span>
            <span className="room-list-item__copy">
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
            <span className="room-list-item__meta">
                {room.timestamp ? (
                    <time>
                        {new Intl.DateTimeFormat(undefined, {
                            hour: "numeric",
                            minute: "2-digit",
                        }).format(room.timestamp)}
                    </time>
                ) : null}
                {room.highlights ? (
                    <span className="highlight-badge">
                        {room.highlights > 99 ? "99+" : room.highlights}
                    </span>
                ) : room.unread ? (
                    <span className="unread-dot" aria-label={`${room.unread} unread`} />
                ) : null}
            </span>
        </button>
    );
}

export function ChatShell({
    service,
    onLogout,
}: {
    service: MatrixService;
    onLogout: () => Promise<void>;
}) {
    const snapshot = useSyncExternalStore(
        service.subscribe,
        service.getSnapshot,
        service.getSnapshot,
    );
    const [roomFilter, setRoomFilter] = useState("");
    const [roomFilterOpen, setRoomFilterOpen] = useState(false);
    const [roomScope, setRoomScope] = useState<RoomScope>("all");
    const deferredFilter = useDeferredValue(roomFilter);
    const [dialog, setDialog] = useState<OpenDialog>(null);
    const [replyingTo, setReplyingTo] = useState<TimelineItem | null>(null);
    const [editing, setEditing] = useState<TimelineItem | null>(null);
    const [mobileRoomsOpen, setMobileRoomsOpen] = useState(!snapshot.activeRoomId);
    const roomSearchInput = useRef<HTMLInputElement>(null);
    const swipeStart = useRef<SwipeStart | null>(null);
    const suppressSwipeClickUntil = useRef(0);
    const historySeeded = useRef(false);
    const activeRoom = snapshot.rooms.find((room) => room.id === snapshot.activeRoomId) ?? null;
    const activeEntryCode = activeRoom
        ? (activeRoom.guideCode ?? guideEntryCode(activeRoom.id))
        : null;

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

        if (roomScope === "favourites") {
            return matching.filter((room) => room.favourite);
        }

        if (roomScope === "invitations") {
            return matching.filter((room) => room.membership === "invite");
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

            if (
                roomId &&
                snapshot.rooms.some((room) => room.id === roomId) &&
                roomId !== service.getSnapshot().activeRoomId
            ) {
                service.selectRoom(roomId);
                setMobileRoomsOpen(false);

                return;
            }

            if (!roomId && isMobileLayout()) {
                setMobileRoomsOpen(true);
            } else if (roomId) {
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
    }, [service, snapshot.rooms]);

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
                setRoomFilterOpen(true);
                window.requestAnimationFrame(() => roomSearchInput.current?.focus());
            } else if (event.key === "Escape" && mobileRoomsOpen && isMobileLayout()) {
                event.preventDefault();
                closeRoomIndex();
            }
        };

        window.addEventListener("keydown", shortcut);

        return () => window.removeEventListener("keydown", shortcut);
    }, [closeRoomIndex, mobileRoomsOpen]);

    const selectRoom = (roomId: string) => {
        service.selectRoom(roomId);
        const mobile = isMobileLayout();
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

        const groupId = `room-group-${title.toLowerCase().replace(/\s+/g, "-")}`;

        return (
            <section className="room-group" aria-labelledby={groupId}>
                <h2 id={groupId}>
                    {title}
                    <span>{countLabel}</span>
                </h2>
                {rooms.map((room) => (
                    <RoomListItem
                        key={room.id}
                        room={room}
                        active={room.id === snapshot.activeRoomId}
                        onClick={() => selectRoom(room.id)}
                    />
                ))}
            </section>
        );
    };

    return (
        <main
            className={`app-shell${mobileRoomsOpen ? " mobile-rooms-open" : ""}`}
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
            <aside className="room-sidebar" aria-label="Rooms">
                <header className="room-sidebar__header">
                    <BrandMark edition="NIGHT RECEIVER CONSOLE" />
                    <button
                        className="room-sidebar__close"
                        type="button"
                        aria-label="Return to the active room"
                        onClick={closeRoomIndex}
                    >
                        <span>Room</span>
                        <ArrowRight />
                    </button>
                </header>
                <div className="room-sidebar__body">
                    <div className="room-column">
                        <div className="transmission-search">
                            <Search aria-hidden="true" />
                            <label className="sr-only" htmlFor="transmission-search">
                                Search transmissions
                            </label>
                            <input
                                ref={roomSearchInput}
                                id="transmission-search"
                                value={roomFilter}
                                onChange={(event) => setRoomFilter(event.target.value)}
                                placeholder="Search transmissions..."
                            />
                            <button
                                type="button"
                                aria-label="New conversation"
                                title="New conversation"
                                onClick={() => setDialog("new")}
                            >
                                <MessageSquarePlus />
                            </button>
                        </div>
                        <div className="room-column__header">
                            <span>
                                <strong>Transmission index</strong>
                                <small>
                                    {filteredRooms.length}{" "}
                                    {filteredRooms.length === 1 ? "entry" : "entries"}
                                </small>
                            </span>
                            <div>
                                <button
                                    type="button"
                                    aria-label="Filter rooms"
                                    title="Filter rooms"
                                    onClick={() => {
                                        setRoomFilterOpen((value) => !value);
                                        window.requestAnimationFrame(() =>
                                            roomSearchInput.current?.focus(),
                                        );
                                    }}
                                >
                                    <Search />
                                </button>
                                <button
                                    className="new-room-button"
                                    type="button"
                                    aria-label="New conversation"
                                    title="New conversation"
                                    onClick={() => setDialog("new")}
                                >
                                    <MessageSquarePlus />
                                </button>
                            </div>
                        </div>
                        <nav className="room-scope-tabs" aria-label="Room views">
                            {(
                                [
                                    { id: "all", label: "All" },
                                    { id: "unread", label: "Unread" },
                                    { id: "favourites", label: "Saved" },
                                    { id: "invitations", label: "Invites" },
                                ] as const
                            ).map((item) => (
                                <button
                                    key={item.id}
                                    className={roomScope === item.id ? "is-active" : ""}
                                    type="button"
                                    aria-pressed={roomScope === item.id}
                                    onClick={() => setRoomScope(item.id)}
                                >
                                    {item.label}
                                    {item.id === "unread" && unreadTotal ? (
                                        <span>{unreadTotal > 99 ? "99+" : unreadTotal}</span>
                                    ) : null}
                                </button>
                            ))}
                        </nav>
                        {roomFilterOpen || roomFilter ? (
                            <div className="room-filter">
                                <Search aria-hidden="true" />
                                <label className="sr-only" htmlFor="room-filter">
                                    Filter rooms
                                </label>
                                <input
                                    ref={roomSearchInput}
                                    id="room-filter"
                                    value={roomFilter}
                                    onChange={(event) => setRoomFilter(event.target.value)}
                                    placeholder="Find a room"
                                />
                                <kbd>⌘K</kbd>
                            </div>
                        ) : null}
                        <nav className="room-list" aria-label="Your Matrix rooms">
                            {roomGroup("Invitations", invitations)}
                            {roomGroup(
                                "Rooms",
                                joinedRooms,
                                `${joinedRooms.length + directMessages.length} tuned`,
                            )}
                            {roomGroup("Direct transmissions", directMessages)}
                            {!filteredRooms.length ? (
                                <div className="room-list-empty">
                                    <Search />
                                    <strong>No rooms found</strong>
                                    <span>The index is being uncharacteristically decisive.</span>
                                </div>
                            ) : null}
                        </nav>
                        <footer className="profile-strip">
                            <button
                                className="profile-strip__settings"
                                type="button"
                                aria-label="Settings"
                                onClick={() => setDialog("settings")}
                            >
                                <Settings />
                            </button>
                            <Avatar
                                name={snapshot.displayName}
                                mxcUrl={snapshot.avatarMxcUrl}
                                service={service}
                            />
                            <button
                                className="profile-strip__identity"
                                type="button"
                                onClick={() => setDialog("settings")}
                            >
                                <span>
                                    <strong>{snapshot.displayName}</strong>
                                    <small>{snapshot.userId}</small>
                                </span>
                            </button>
                            <button
                                className="profile-strip__saved"
                                type="button"
                                aria-label="Show saved transmissions"
                                onClick={() => setRoomScope("favourites")}
                            >
                                <Star />
                            </button>
                        </footer>
                        <div className="sidebar-folio">Field guide · Vol. 01 · Page 17</div>
                    </div>
                </div>
            </aside>

            <section
                className={`conversation${!activeRoom || activeRoom.membership === "invite" ? " conversation--single" : ""}`}
                aria-label={activeRoom ? activeRoom.name : "No room selected"}
            >
                {activeRoom ? (
                    <>
                        <div className="conversation-main" key={activeRoom.id}>
                            <header className="conversation-header">
                                <button
                                    className="mobile-menu-button"
                                    type="button"
                                    aria-label="Open transmission index"
                                    onClick={showRoomIndex}
                                >
                                    <ArrowLeft />
                                    <span>Index</span>
                                </button>
                                <div className="conversation-header__title">
                                    <span className="conversation-entry">
                                        Entry {activeEntryCode}
                                    </span>
                                    <h1>
                                        {activeRoom.name}
                                        {activeRoom.muted ? <BellOff aria-label="Muted" /> : null}
                                    </h1>
                                    <p>
                                        <span className="room-classification">
                                            Classification:{" "}
                                            {activeRoom.classification ??
                                                (activeRoom.memberCount <= 2
                                                    ? "Direct transmission"
                                                    : "Field observations")}
                                        </span>
                                        <span className="room-privacy-state">
                                            {activeRoom.encrypted ? <LockKeyhole /> : null}
                                            {activeRoom.encrypted
                                                ? "Private end to end"
                                                : "Unencrypted"}
                                        </span>
                                        <span
                                            className={`room-live-state room-live-state--${snapshot.connection}`}
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
                                <div className="conversation-commands">
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
                                <div className="invite-view">
                                    <div className="invite-card">
                                        <span className="index-chip">INVITE</span>
                                        <Avatar
                                            name={activeRoom.name}
                                            mxcUrl={activeRoom.avatarMxcUrl}
                                            service={service}
                                            size="large"
                                        />
                                        <h2>You have been invited to {activeRoom.name}</h2>
                                        <p>
                                            The room would like to contain you. This is more
                                            courteous than most rooms manage.
                                        </p>
                                        <div>
                                            <button
                                                className="primary-button"
                                                type="button"
                                                onClick={() => void service.joinRoom(activeRoom.id)}
                                            >
                                                <Check />
                                                Accept invitation
                                            </button>
                                            <button
                                                className="secondary-button"
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
                                    <div className="conversation-stage">
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
                                        className={`typing-line${snapshot.typingNames.length ? " is-active" : ""}`}
                                        aria-live="polite"
                                        aria-atomic="true"
                                    >
                                        {snapshot.typingNames.length ? (
                                            <>
                                                <span className="typing-dots" aria-hidden="true">
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
                                        key={`${activeRoom.id}:${editing?.id ?? "compose"}`}
                                        roomId={activeRoom.id}
                                        service={service}
                                        replyingTo={replyingTo}
                                        editing={editing}
                                        onClearContext={() => {
                                            setReplyingTo(null);
                                            setEditing(null);
                                        }}
                                    />
                                    <footer
                                        className="receiver-status"
                                        aria-label="Receiver status"
                                    >
                                        <ConnectionPill state={snapshot.connection} />
                                        <span>
                                            <LockKeyhole />
                                            <strong>Encryption</strong>
                                            {activeRoom.encrypted ? "End-to-end" : "Not encrypted"}
                                        </span>
                                        <button type="button" onClick={() => setDialog("details")}>
                                            <Users />
                                            <strong>{activeRoom.memberCount}</strong>
                                            {activeRoom.memberCount === 1 ? "member" : "members"}
                                        </button>
                                    </footer>
                                </>
                            )}
                        </div>
                        {activeRoom.membership !== "invite" ? (
                            <aside
                                className="room-guide-panel"
                                aria-labelledby="room-guide-heading"
                            >
                                <h2 id="room-guide-heading">About this transmission</h2>
                                <dl className="room-guide-details">
                                    <div>
                                        <dt>
                                            <Crosshair />
                                            Purpose
                                        </dt>
                                        <dd>
                                            {activeRoom.topic ??
                                                "Live room coordination and field observations"}
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>
                                            <Users />
                                            Members
                                        </dt>
                                        <dd>{activeRoom.memberCount} members</dd>
                                    </div>
                                    <div>
                                        <dt>
                                            <LockKeyhole />
                                            Privacy
                                        </dt>
                                        <dd>
                                            {activeRoom.encrypted
                                                ? "Private end to end. Intermediate space remains uninformed."
                                                : "Unencrypted transmission."}
                                        </dd>
                                    </div>
                                </dl>
                                <figure className="room-guide-diagram">
                                    <h3>Fig. {activeEntryCode} — Receiver diagram</h3>
                                    <div className="room-guide-diagram__plate">
                                        {/* eslint-disable-next-line @next/next/no-img-element -- Original receiver diagram supplied with the app. */}
                                        <img
                                            src="/night-receiver-plate.png"
                                            alt="Abstract receiver diagram with orbit and signal traces"
                                            loading="lazy"
                                            decoding="async"
                                        />
                                    </div>
                                    <figcaption>
                                        Signal path and sweep overlay.
                                        <br />
                                        Carrier trace in red.
                                    </figcaption>
                                </figure>
                                <section className="room-guide-note">
                                    <div>
                                        <h3>Guide note</h3>
                                        <p>
                                            Carrier found. It was under the usual pile of cosmic
                                            noise.
                                        </p>
                                    </div>
                                    <Crosshair aria-hidden="true" />
                                </section>
                                <footer className="room-guide-meta">
                                    <span>Coordinate&nbsp;&nbsp; Local device</span>
                                    <span>Frequency&nbsp;&nbsp; Matrix / live</span>
                                    <span>Field guide&nbsp;&nbsp; Vol. 01 / Page 17</span>
                                </footer>
                            </aside>
                        ) : null}
                    </>
                ) : (
                    <div className="no-room-view">
                        <div className="guide-card">
                            <span className="guide-card__number">01</span>
                            <p className="eyebrow">CHANNEL SELECTOR</p>
                            <h1>Choose a conversation.</h1>
                            <p>
                                Your messages are all present, assuming the universe and your
                                homeserver are both behaving within published tolerances.
                            </p>
                            <button
                                className="primary-button"
                                type="button"
                                onClick={() => setDialog("new")}
                            >
                                <UserPlus />
                                Start a transmission
                            </button>
                        </div>
                    </div>
                )}
            </section>

            <button
                className="sidebar-scrim"
                type="button"
                aria-label="Close room list"
                onClick={closeRoomIndex}
            />
            {snapshot.error ? (
                <div className="app-toast" role="alert">
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
