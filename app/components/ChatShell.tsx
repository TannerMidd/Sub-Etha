"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  BellOff,
  Check,
  Info,
  LockKeyhole,
  MessageSquarePlus,
  Search,
  Settings,
  Signal,
  SignalLow,
  UserPlus,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import type { RoomSummary, TimelineItem } from "@/lib/matrix/types";
import { Avatar, BrandMark } from "./BrandMark";
import { Composer } from "./Composer";
import { NewConversationDialog, RoomDetailsDialog, SearchDialog, SettingsDialog } from "./Panels";
import { Timeline } from "./Timeline";

type OpenDialog = "new" | "search" | "settings" | "details" | null;

function parseRoomHash(): string | null {
  const match = window.location.hash.match(/^#\/room\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function ConnectionPill({ state }: { state: ReturnType<MatrixService["getSnapshot"]>["connection"] }) {
  if (state === "ready") return <span className="connection-pill connection-pill--ready"><Signal />Live</span>;
  if (state === "offline") return <span className="connection-pill connection-pill--offline"><WifiOff />Offline</span>;
  if (state === "error") return <span className="connection-pill connection-pill--error"><SignalLow />Signal trouble</span>;
  return <span className="connection-pill"><SignalLow />{state === "catching-up" ? "Catching up" : "Tuning"}</span>;
}

function RoomListItem({ room, active, onClick }: { room: RoomSummary; active: boolean; onClick: () => void }) {
  return (
    <button className={`room-list-item${active ? " is-active" : ""}`} type="button" onClick={onClick} aria-current={active ? "page" : undefined}>
      <Avatar name={room.name} src={room.avatarUrl} />
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
  const deferredFilter = useDeferredValue(roomFilter);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [replyingTo, setReplyingTo] = useState<TimelineItem | null>(null);
  const [editing, setEditing] = useState<TimelineItem | null>(null);
  const [mobileRoomsOpen, setMobileRoomsOpen] = useState(!snapshot.activeRoomId);
  const roomSearchInput = useRef<HTMLInputElement>(null);
  const activeRoom = snapshot.rooms.find((room) => room.id === snapshot.activeRoomId) ?? null;

  const filteredRooms = useMemo(() => {
    const query = deferredFilter.trim().toLowerCase();
    return query ? snapshot.rooms.filter((room) => `${room.name} ${room.lastMessage}`.toLowerCase().includes(query)) : snapshot.rooms;
  }, [deferredFilter, snapshot.rooms]);

  const invitations = filteredRooms.filter((room) => room.membership === "invite");
  const favourites = filteredRooms.filter((room) => room.membership !== "invite" && room.favourite);
  const others = filteredRooms.filter((room) => room.membership !== "invite" && !room.favourite);

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
        roomSearchInput.current?.focus();
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

  const roomGroup = (title: string, rooms: RoomSummary[]) => rooms.length ? (
    <section className="room-group" aria-labelledby={`room-group-${title}`}>
      <h2 id={`room-group-${title}`}>{title}<span>{rooms.length}</span></h2>
      {rooms.map((room) => <RoomListItem key={room.id} room={room} active={room.id === snapshot.activeRoomId} onClick={() => selectRoom(room.id)} />)}
    </section>
  ) : null;

  return (
    <main className={`app-shell${mobileRoomsOpen ? " mobile-rooms-open" : ""}`}>
      <aside className="room-sidebar" aria-label="Rooms">
        <header className="room-sidebar__header">
          <BrandMark compact />
          <button className="new-room-button" type="button" aria-label="New conversation" title="New conversation" onClick={() => setDialog("new")}><MessageSquarePlus /></button>
        </header>
        <div className="room-filter">
          <Search aria-hidden="true" /><label className="sr-only" htmlFor="room-filter">Filter rooms</label>
          <input ref={roomSearchInput} id="room-filter" value={roomFilter} onChange={(event) => setRoomFilter(event.target.value)} placeholder="Find a room" />
          <kbd>⌘K</kbd>
        </div>
        <nav className="room-list" aria-label="Your Matrix rooms">
          {roomGroup("Invitations", invitations)}
          {roomGroup("Favourites", favourites)}
          {roomGroup("Messages", others)}
          {!filteredRooms.length ? <div className="room-list-empty"><Search /><strong>No rooms found</strong><span>The index is being uncharacteristically decisive.</span></div> : null}
        </nav>
        <footer className="profile-strip">
          <Avatar name={snapshot.displayName} src={snapshot.avatarUrl} />
          <button type="button" onClick={() => setDialog("settings")}><span><strong>{snapshot.displayName}</strong><small>{snapshot.userId}</small></span><Settings /></button>
        </footer>
      </aside>

      <section className="conversation" aria-label={activeRoom ? activeRoom.name : "No room selected"}>
        {activeRoom ? (
          <>
            <header className="conversation-header">
              <button className="mobile-menu-button" type="button" aria-label="Show rooms" onClick={() => setMobileRoomsOpen(true)}><ArrowLeft /></button>
              <Avatar name={activeRoom.name} src={activeRoom.avatarUrl} />
              <div className="conversation-header__title">
                <h1>{activeRoom.name}{activeRoom.muted ? <BellOff aria-label="Muted" /> : null}</h1>
                <p>{activeRoom.encrypted ? <><LockKeyhole />Encrypted</> : "Unencrypted"}<span>·</span><Users />{activeRoom.memberCount}</p>
              </div>
              <ConnectionPill state={snapshot.connection} />
              <button className="icon-button" type="button" aria-label="Search this room" title="Search this room" onClick={() => setDialog("search")}><Search /></button>
              <button className="icon-button" type="button" aria-label="Room details" title="Room details" onClick={() => setDialog("details")}><Info /></button>
            </header>
            {activeRoom.membership === "invite" ? (
              <div className="invite-view">
                <div className="invite-card">
                  <span className="index-chip">INVITE</span>
                  <Avatar name={activeRoom.name} src={activeRoom.avatarUrl} size="large" />
                  <h2>You have been invited to {activeRoom.name}</h2>
                  <p>The room would like to contain you. This is more courteous than most rooms manage.</p>
                  <div><button className="primary-button" type="button" onClick={() => void service.joinRoom(activeRoom.id)}><Check />Accept invitation</button><button className="secondary-button" type="button" onClick={() => void service.leaveActiveRoom()}><X />Decline</button></div>
                </div>
              </div>
            ) : (
              <>
                <Timeline items={snapshot.timeline} service={service} loadingHistory={snapshot.loadingHistory} onReply={(item) => { setReplyingTo(item); setEditing(null); }} onEdit={(item) => { setEditing(item); setReplyingTo(null); }} />
                <div className="typing-line" aria-live="polite">{snapshot.typingNames.length ? `${snapshot.typingNames.join(", ")} ${snapshot.typingNames.length === 1 ? "is" : "are"} typing…` : "\u00a0"}</div>
                <Composer key={`${activeRoom.id}:${editing?.id ?? "compose"}`} roomId={activeRoom.id} service={service} replyingTo={replyingTo} editing={editing} onClearContext={() => { setReplyingTo(null); setEditing(null); }} />
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
      {dialog === "settings" ? <SettingsDialog service={service} onClose={() => setDialog(null)} onLogout={onLogout} /> : null}
      {dialog === "details" && activeRoom ? <RoomDetailsDialog room={activeRoom} service={service} onClose={() => setDialog(null)} /> : null}
    </main>
  );
}
