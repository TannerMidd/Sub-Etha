"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  BellOff,
  Check,
  CircleDot,
  Info,
  Inbox,
  LockKeyhole,
  MessageSquareText,
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
import type { RoomSummary, TimelineItem } from "@/lib/matrix/types";
import { Avatar, BrandMark } from "./BrandMark";
import { Composer } from "./Composer";
import { NewConversationDialog, RoomDetailsDialog, SearchDialog, SettingsDialog, VerificationDialog } from "./Panels";
import { Timeline } from "./Timeline";

type OpenDialog = "new" | "search" | "settings" | "details" | null;
type RoomScope = "all" | "unread" | "favourites" | "invitations";

function parseRoomHash(): string | null {
  const match = window.location.hash.match(/^#\/room\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function ConnectionPill({ state }: { state: ReturnType<MatrixService["getSnapshot"]>["connection"] }) {
  if (state === "ready") return <span className="connection-pill connection-pill--ready"><Signal />Connected</span>;
  if (state === "offline") return <span className="connection-pill connection-pill--offline"><WifiOff />Offline</span>;
  if (state === "error") return <span className="connection-pill connection-pill--error"><SignalLow />Signal trouble</span>;
  return <span className="connection-pill"><SignalLow />{state === "catching-up" ? "Catching up" : "Tuning"}</span>;
}

function RoomListItem({ room, service, active, onClick }: { room: RoomSummary; service: MatrixService; active: boolean; onClick: () => void }) {
  return (
    <button className={`room-list-item${active ? " is-active" : ""}`} type="button" onClick={onClick} aria-current={active ? "page" : undefined}>
      <Avatar name={room.name} mxcUrl={room.avatarMxcUrl} service={service} />
      <span className="room-list-item__copy">
        <span><strong>{room.name}</strong>{room.encrypted ? <LockKeyhole aria-label="Encrypted" /> : null}</span>
        <small>{room.membership === "invite" ? "Invitation waiting" : room.lastMessage}</small>
      </span>
      <span className="room-list-item__meta">
        {room.timestamp ? <time>{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(room.timestamp)}</time> : null}
        {room.highlights ? <span className="highlight-badge">{room.highlights > 99 ? "99+" : room.highlights}</span> : room.unread ? <span className="unread-dot" aria-label={`${room.unread} unread`} /> : null}
      </span>
    </button>
  );
}

export function ChatShell({ service, onLogout }: { service: MatrixService; onLogout: () => Promise<void> }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot);
  const [roomFilter, setRoomFilter] = useState("");
  const [roomFilterOpen, setRoomFilterOpen] = useState(false);
  const [roomScope, setRoomScope] = useState<RoomScope>("all");
  const deferredFilter = useDeferredValue(roomFilter);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [replyingTo, setReplyingTo] = useState<TimelineItem | null>(null);
  const [editing, setEditing] = useState<TimelineItem | null>(null);
  const [mobileRoomsOpen, setMobileRoomsOpen] = useState(!snapshot.activeRoomId);
  const roomSearchInput = useRef<HTMLInputElement>(null);
  const activeRoom = snapshot.rooms.find((room) => room.id === snapshot.activeRoomId) ?? null;

  const filteredRooms = useMemo(() => {
    const query = deferredFilter.trim().toLowerCase();
    const matching = query ? snapshot.rooms.filter((room) => `${room.name} ${room.lastMessage}`.toLowerCase().includes(query)) : snapshot.rooms;
    if (roomScope === "unread") return matching.filter((room) => room.unread || room.highlights);
    if (roomScope === "favourites") return matching.filter((room) => room.favourite);
    if (roomScope === "invitations") return matching.filter((room) => room.membership === "invite");
    return matching;
  }, [deferredFilter, roomScope, snapshot.rooms]);

  const invitations = filteredRooms.filter((room) => room.membership === "invite");
  const joinedRooms = filteredRooms.filter((room) => room.membership !== "invite" && room.memberCount > 2);
  const directMessages = filteredRooms.filter((room) => room.membership !== "invite" && room.memberCount <= 2);
  const unreadTotal = snapshot.rooms.reduce((total, room) => total + room.unread, 0);

  useEffect(() => {
    const selectFromHash = () => {
      const roomId = parseRoomHash();
      if (roomId && snapshot.rooms.some((room) => room.id === roomId) && roomId !== service.getSnapshot().activeRoomId) {
        service.selectRoom(roomId);
        setMobileRoomsOpen(false);
      }
    };
    selectFromHash();
    window.addEventListener("hashchange", selectFromHash);
    return () => window.removeEventListener("hashchange", selectFromHash);
  }, [service, snapshot.rooms]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setRoomFilterOpen(true);
        window.requestAnimationFrame(() => roomSearchInput.current?.focus());
      }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);

  const selectRoom = (roomId: string) => {
    service.selectRoom(roomId);
    window.location.assign(`#/room/${encodeURIComponent(roomId)}`);
    setMobileRoomsOpen(false);
    setReplyingTo(null);
    setEditing(null);
  };

  const roomGroup = (title: string, rooms: RoomSummary[]) => {
    if (!rooms.length) return null;
    const groupId = `room-group-${title.toLowerCase().replace(/\s+/g, "-")}`;
    return (
      <section className="room-group" aria-labelledby={groupId}>
        <h2 id={groupId}>{title}<span>{rooms.length}</span></h2>
        {rooms.map((room) => <RoomListItem key={room.id} room={room} service={service} active={room.id === snapshot.activeRoomId} onClick={() => selectRoom(room.id)} />)}
      </section>
    );
  };

  return (
    <main className={`app-shell${mobileRoomsOpen ? " mobile-rooms-open" : ""}`}>
      <aside className="room-sidebar" aria-label="Rooms">
        <header className="room-sidebar__header">
          <BrandMark edition="NIGHT RECEIVER CONSOLE" />
        </header>
        <div className="room-sidebar__body">
          <nav className="receiver-rail" aria-label="Room views">
            {([
              { id: "all", label: "All rooms", icon: MessageSquareText },
              { id: "unread", label: "Unread rooms", icon: CircleDot },
              { id: "favourites", label: "Favourite rooms", icon: Star },
              { id: "invitations", label: "Invitations", icon: Inbox },
            ] as const).map((item) => (
              <button key={item.id} className={roomScope === item.id ? "is-active" : ""} type="button" aria-label={item.label} title={item.label} onClick={() => setRoomScope(item.id)}>
                <item.icon />
                {item.id === "unread" && unreadTotal ? <span>{unreadTotal > 99 ? "99+" : unreadTotal}</span> : null}
              </button>
            ))}
            <span className="receiver-rail__spacer" />
            <button type="button" aria-label="Settings" title="Settings" onClick={() => setDialog("settings")}><Settings /></button>
          </nav>
          <div className="room-column">
            <div className="room-column__header">
              <span><strong>{roomScope === "all" ? "Rooms" : roomScope}</strong><small>{filteredRooms.length} tuned</small></span>
              <div>
                <button type="button" aria-label="Filter rooms" title="Filter rooms" onClick={() => { setRoomFilterOpen((value) => !value); window.requestAnimationFrame(() => roomSearchInput.current?.focus()); }}><Search /></button>
                <button className="new-room-button" type="button" aria-label="New conversation" title="New conversation" onClick={() => setDialog("new")}><MessageSquarePlus /></button>
              </div>
            </div>
            {roomFilterOpen || roomFilter ? <div className="room-filter">
              <Search aria-hidden="true" /><label className="sr-only" htmlFor="room-filter">Filter rooms</label>
              <input ref={roomSearchInput} id="room-filter" value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)} placeholder="Find a room" />
              <kbd>⌘K</kbd>
            </div> : null}
            <nav className="room-list" aria-label="Your Matrix rooms">
              {roomGroup("Invitations", invitations)}
              {roomGroup("Rooms", joinedRooms)}
              {roomGroup("Direct messages", directMessages)}
              {!filteredRooms.length ? <div className="room-list-empty"><Search /><strong>No rooms found</strong><span>The index is being uncharacteristically decisive.</span></div> : null}
            </nav>
            <footer className="profile-strip">
              <Avatar name={snapshot.displayName} mxcUrl={snapshot.avatarMxcUrl} service={service} />
              <button type="button" onClick={() => setDialog("settings")}><span><strong>{snapshot.displayName}</strong><small>{snapshot.userId}</small></span><Settings /></button>
            </footer>
          </div>
        </div>
      </aside>

      <section className="conversation" aria-label={activeRoom ? activeRoom.name : "No room selected"}>
        {activeRoom ? (
          <>
            <header className="conversation-header">
              <button className="mobile-menu-button" type="button" aria-label="Show rooms" onClick={() => setMobileRoomsOpen(true)}><ArrowLeft /></button>
              <Avatar name={activeRoom.name} mxcUrl={activeRoom.avatarMxcUrl} service={service} />
              <div className="conversation-header__title">
                <h1>{activeRoom.name}{activeRoom.muted ? <BellOff aria-label="Muted" /> : null}</h1>
                <p><span className="member-count">{activeRoom.memberCount} {activeRoom.memberCount === 1 ? "member" : "members"}</span><span>·</span>{activeRoom.encrypted ? <><LockKeyhole />Encrypted end-to-end</> : "Unencrypted"}</p>
              </div>
              <div className="conversation-commands">
                <button type="button" aria-label="Search this room" onClick={() => setDialog("search")}><Search /><span>Search</span></button>
                <button type="button" aria-label={`${activeRoom.memberCount} members`} onClick={() => setDialog("details")}><Users /><span>Members</span><small>{activeRoom.memberCount}</small></button>
                <button type="button" aria-label="Room details" onClick={() => setDialog("details")}><Info /><span>Details</span></button>
              </div>
            </header>
            {activeRoom.membership === "invite" ? (
              <div className="invite-view">
                <div className="invite-card">
                  <span className="index-chip">INVITE</span>
                  <Avatar name={activeRoom.name} mxcUrl={activeRoom.avatarMxcUrl} service={service} size="large" />
                  <h2>You have been invited to {activeRoom.name}</h2>
                  <p>The room would like to contain you. This is more courteous than most rooms manage.</p>
                  <div><button className="primary-button" type="button" onClick={() => void service.joinRoom(activeRoom.id)}><Check />Accept invitation</button><button className="secondary-button" type="button" onClick={() => void service.leaveActiveRoom()}><X />Decline</button></div>
                </div>
              </div>
            ) : (
              <>
                <div className="conversation-stage">
                  <Timeline items={snapshot.timeline} service={service} loadingHistory={snapshot.loadingHistory} unreadCount={activeRoom.unread} onReply={(item) => { setReplyingTo(item); setEditing(null); }} onEdit={(item) => { setEditing(item); setReplyingTo(null); }} />
                  <aside className="receiver-field-guide" aria-hidden="true">
                    {/* eslint-disable-next-line @next/next/no-img-element -- Generated decorative brand plate. */}
                    <img className="receiver-field-guide__dark" src="/night-receiver-plate.png" alt="" />
                    {/* eslint-disable-next-line @next/next/no-img-element -- Generated decorative brand plate. */}
                    <img className="receiver-field-guide__light" src="/og.png" alt="" />
                    <p>COORDINATE&nbsp;&nbsp; LOCAL DEVICE</p>
                    <p>FREQUENCY&nbsp;&nbsp; MATRIX / LIVE</p>
                    <p>FIELD GUIDE&nbsp;&nbsp; VOL. 01 / PAGE 17</p>
                  </aside>
                </div>
                <div className="typing-line" aria-live="polite">{snapshot.typingNames.length ? `${snapshot.typingNames.join(", ")} ${snapshot.typingNames.length === 1 ? "is" : "are"} typing…` : "\u00a0"}</div>
                <Composer key={`${activeRoom.id}:${editing?.id ?? "compose"}`} roomId={activeRoom.id} service={service} replyingTo={replyingTo} editing={editing} onClearContext={() => { setReplyingTo(null); setEditing(null); }} />
                <footer className="receiver-status" aria-label="Receiver status">
                  <ConnectionPill state={snapshot.connection} />
                  <span><LockKeyhole /><strong>Encryption</strong>{activeRoom.encrypted ? "End-to-end" : "Not encrypted"}</span>
                  <button type="button" onClick={() => setDialog("details")}><Users /><strong>{activeRoom.memberCount}</strong>{activeRoom.memberCount === 1 ? "member" : "members"}</button>
                </footer>
              </>
            )}
          </>
        ) : (
          <div className="no-room-view">
            <div className="guide-card">
              <span className="guide-card__number">42</span>
              <p className="eyebrow">CHANNEL SELECTOR</p>
              <h1>Choose a conversation.</h1>
              <p>Your messages are all present, assuming the universe and your homeserver are both behaving within published tolerances.</p>
              <button className="primary-button" type="button" onClick={() => setDialog("new")}><UserPlus />Start a transmission</button>
            </div>
          </div>
        )}
      </section>

      <button className="sidebar-scrim" type="button" aria-label="Close room list" onClick={() => setMobileRoomsOpen(false)} />
      {snapshot.error ? <div className="app-toast" role="alert"><SignalLow /><span>{snapshot.error}</span><button type="button" aria-label="Dismiss" onClick={() => service.clearError()}><X /></button></div> : null}
      {dialog === "new" ? <NewConversationDialog service={service} onClose={() => setDialog(null)} /> : null}
      {dialog === "search" ? <SearchDialog service={service} onClose={() => setDialog(null)} /> : null}
      {dialog === "settings" ? <SettingsDialog service={service} onClose={() => setDialog(null)} onLogout={onLogout} onVerificationStarted={() => setDialog(null)} /> : null}
      {dialog === "details" && activeRoom ? <RoomDetailsDialog room={activeRoom} service={service} onClose={() => setDialog(null)} /> : null}
      {snapshot.verification ? <VerificationDialog verification={snapshot.verification} service={service} /> : null}
    </main>
  );
}
