"use client";

import { useEffect, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Copy,
  DoorOpen,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Moon,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import { disablePush, enablePush, readPushState } from "@/lib/matrix/notifications";
import type { DeviceSummary, PushState, RoomSummary, TimelineItem } from "@/lib/matrix/types";
import { Avatar } from "./BrandMark";

export function Dialog({
  title,
  eyebrow,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  onClose: () => void;
  children: React.ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const handle = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handle);
    dialogRef.current?.querySelector<HTMLElement>("[data-dialog-autofocus]")?.focus();
    return () => window.removeEventListener("keydown", handle);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className={`dialog-card${wide ? " dialog-card--wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <header className="dialog-card__header">
          <div>{eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}<h2 id="dialog-title">{title}</h2></div>
          <button className="icon-button" type="button" aria-label="Close" onClick={onClose}><X /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function NewConversationDialog({ service, onClose }: { service: MatrixService; onClose: () => void }) {
  const [mode, setMode] = useState<"dm" | "room" | "join">("dm");
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [encrypted, setEncrypted] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "join") await service.joinRoom(target);
      else await service.createRoom({ name: mode === "room" ? name : undefined, invite: target, direct: mode === "dm", encrypted });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The room could not be reached.");
      setBusy(false);
    }
  };

  return (
    <Dialog title="Open a channel" eyebrow="NEW TRANSMISSION" onClose={onClose}>
      <div className="segmented-control" role="tablist" aria-label="Conversation type">
        {(["dm", "room", "join"] as const).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={mode === value} onClick={() => setMode(value)}>
            {value === "dm" ? "Direct" : value === "room" ? "Room" : "Join"}
          </button>
        ))}
      </div>
      <form className="panel-form" onSubmit={submit}>
        {mode === "room" ? <><label htmlFor="room-name">Room name</label><input id="room-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Tea at the end of the universe" /></> : null}
        <label htmlFor="room-target">{mode === "join" ? "Room alias or ID" : mode === "dm" ? "Matrix user ID" : "Invite someone (optional)"}</label>
        <input id="room-target" data-dialog-autofocus value={target} onChange={(event) => setTarget(event.target.value)} placeholder={mode === "join" ? "#room:example.org" : "@friend:example.org"} required={mode !== "room"} />
        {mode !== "join" ? <label className="check-row"><input type="checkbox" checked={encrypted} onChange={(event) => setEncrypted(event.target.checked)} /><span><LockKeyhole />Enable end-to-end encryption</span></label> : null}
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={busy || (mode !== "room" && !target.trim())}>
          {busy ? <><LoaderCircle className="spin" /> Reticulating room aliases…</> : <>Continue <ChevronRight /></>}
        </button>
      </form>
    </Dialog>
  );
}

export function SearchDialog({ service, onClose }: { service: MatrixService; onClose: () => void }) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<TimelineItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { setResults(await service.searchCurrentRoom(term)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Search is not supported by this homeserver."); }
    finally { setBusy(false); }
  };

  return (
    <Dialog title="Search this room" eyebrow="MESSAGE INDEX" onClose={onClose} wide>
      <form className="search-form" onSubmit={search}>
        <Search aria-hidden="true" /><label className="sr-only" htmlFor="room-search-term">Search messages</label>
        <input id="room-search-term" data-dialog-autofocus value={term} onChange={(event) => setTerm(event.target.value)} placeholder="A phrase worth finding again" />
        <button type="submit" disabled={busy || !term.trim()}>{busy ? <LoaderCircle className="spin" /> : "Search"}</button>
      </form>
      {error ? <div className="error-note"><strong>Search unavailable.</strong><span>{error}</span></div> : null}
      <div className="search-results" aria-live="polite">
        {!busy && term && !results.length && !error ? <p className="empty-note">No matching transmissions. The universe remains coy.</p> : null}
        {results.map((result) => (
          <button key={result.id} type="button" onClick={() => { window.location.assign(`#/room/${encodeURIComponent(service.getSnapshot().activeRoomId ?? "")}/event/${encodeURIComponent(result.id)}`); onClose(); }}>
            <Avatar name={result.senderName} src={result.senderAvatarUrl} size="small" />
            <span><strong>{result.senderName}</strong><span>{result.body}</span></span>
            <time>{new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(result.timestamp)}</time>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

export function RoomDetailsDialog({ room, service, onClose }: { room: RoomSummary; service: MatrixService; onClose: () => void }) {
  const [invitee, setInvitee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(room.muted);

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { await service.invite(invitee); setInvitee(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Invitation failed."); }
    finally { setBusy(false); }
  };

  return (
    <Dialog title={room.name} eyebrow="ROOM FIELD NOTES" onClose={onClose}>
      <div className="room-profile">
        <Avatar name={room.name} src={room.avatarUrl} size="large" />
        <div><strong>{room.memberCount} {room.memberCount === 1 ? "member" : "members"}</strong><span>{room.encrypted ? "End-to-end encrypted" : "Not encrypted"}</span></div>
      </div>
      <div className="settings-list">
        <button type="button" onClick={async () => { const next = !muted; setMuted(next); await service.setRoomMuted(next); }}>
          {muted ? <BellOff /> : <Bell />}<span><strong>{muted ? "Notifications muted" : "Notifications on"}</strong><small>Change alerts for this room</small></span><ChevronRight />
        </button>
      </div>
      <form className="panel-form panel-form--inline" onSubmit={invite}>
        <label htmlFor="invite-user">Invite a Matrix user</label>
        <div><input id="invite-user" value={invitee} onChange={(event) => setInvitee(event.target.value)} placeholder="@friend:example.org" /><button type="submit" disabled={busy || !invitee.trim()} aria-label="Invite"><UserPlus /></button></div>
      </form>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <button className="danger-button" type="button" onClick={async () => {
        if (window.confirm(`Leave “${room.name}”? You can only return if the room permits it or someone invites you.`)) {
          await service.leaveActiveRoom();
          onClose();
        }
      }}><DoorOpen />Leave room</button>
    </Dialog>
  );
}

export function SettingsDialog({ service, onClose, onLogout }: { service: MatrixService; onClose: () => void; onLogout: () => Promise<void> }) {
  const snapshot = service.getSnapshot();
  const [displayName, setDisplayName] = useState(snapshot.displayName);
  const [avatar, setAvatar] = useState<File | undefined>();
  const [theme, setTheme] = useState(() => localStorage.getItem("sub-etha-theme") ?? "system");
  const [pushState, setPushState] = useState<PushState>(() => readPushState());
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [cryptoStatus, setCryptoStatus] = useState<{ secretStorageReady: boolean; crossSigningReady: boolean; backupVersion: string | null } | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [recoveryInput, setRecoveryInput] = useState("");
  const [generatedRecovery, setGeneratedRecovery] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([service.getDevices(), service.getCryptoStatus()]).then(([nextDevices, nextCrypto]) => {
      setDevices(nextDevices);
      setCryptoStatus(nextCrypto);
    }).catch(() => undefined);
  }, [service]);

  const act = async (name: string, action: () => Promise<void>) => {
    setBusyAction(name);
    setError(null);
    setNotice(null);
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The operation failed."); }
    finally { setBusyAction(null); }
  };

  const setThemeChoice = (value: string) => {
    setTheme(value);
    localStorage.setItem("sub-etha-theme", value);
    if (value === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", value);
  };

  return (
    <Dialog title="Settings" eyebrow="DEVICE & ACCOUNT" onClose={onClose} wide>
      <div className="settings-grid">
        <section>
          <h3><Users />Profile</h3>
          <form className="panel-form" onSubmit={(event) => {
            event.preventDefault();
            void act("profile", async () => { await service.updateProfile(displayName, avatar); setNotice("Profile updated."); });
          }}>
            <label htmlFor="display-name">Display name</label>
            <input id="display-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
            <label htmlFor="avatar-file">Profile picture</label>
            <input id="avatar-file" type="file" accept="image/*" onChange={(event) => setAvatar(event.target.files?.[0])} />
            <button className="secondary-button" type="submit" disabled={busyAction === "profile"}>{busyAction === "profile" ? <LoaderCircle className="spin" /> : <Check />}Save profile</button>
          </form>

          <h3><Sun />Appearance</h3>
          <div className="theme-options" role="radiogroup" aria-label="Theme">
            {[{ value: "system", label: "System", icon: Settings }, { value: "light", label: "Light", icon: Sun }, { value: "dark", label: "Dark", icon: Moon }].map((option) => (
              <button key={option.value} type="button" role="radio" aria-checked={theme === option.value} onClick={() => setThemeChoice(option.value)}>
                <option.icon />{option.label}{theme === option.value ? <Check /> : null}
              </button>
            ))}
          </div>

          <h3><Bell />Notifications</h3>
          <div className="settings-block">
            <div><strong>Closed-app notifications</strong><p>Generic alerts only. The gateway never receives message text, sender or room names.</p></div>
            <button className="secondary-button" type="button" disabled={!pushState.supported || busyAction === "push"} onClick={() => void act("push", async () => {
              setPushState(pushState.enabled ? await disablePush(service) : await enablePush(service));
            })}>{pushState.enabled ? <><BellOff />Disable</> : <><Bell />Enable</>}</button>
            {pushState.permission === "denied" ? <p className="inline-error">Notifications are blocked in browser settings.</p> : null}
          </div>
        </section>

        <section>
          <h3><ShieldCheck />Encryption & recovery</h3>
          <div className="crypto-status">
            <span className={cryptoStatus?.secretStorageReady ? "is-ready" : ""}>{cryptoStatus?.secretStorageReady ? <Check /> : <KeyRound />}Secret storage</span>
            <span className={cryptoStatus?.crossSigningReady ? "is-ready" : ""}>{cryptoStatus?.crossSigningReady ? <Check /> : <KeyRound />}Cross-signing</span>
            <span className={cryptoStatus?.backupVersion ? "is-ready" : ""}>{cryptoStatus?.backupVersion ? <Check /> : <KeyRound />}Key backup</span>
          </div>
          {!cryptoStatus?.secretStorageReady ? (
            <div className="settings-block">
              <label htmlFor="recovery-passphrase">Optional recovery passphrase</label>
              <input id="recovery-passphrase" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Leave blank for a recovery key" />
              <button className="secondary-button" type="button" disabled={busyAction === "recovery"} onClick={() => void act("recovery", async () => {
                const key = await service.setupRecovery(passphrase);
                setGeneratedRecovery(key);
                setCryptoStatus(await service.getCryptoStatus());
              })}><LockKeyhole />Set up recovery</button>
            </div>
          ) : (
            <div className="settings-block">
              <label htmlFor="recovery-key">Recovery key or passphrase</label>
              <textarea id="recovery-key" rows={3} value={recoveryInput} onChange={(event) => setRecoveryInput(event.target.value)} />
              <button className="secondary-button" type="button" disabled={!recoveryInput.trim() || busyAction === "unlock"} onClick={() => void act("unlock", async () => {
                await service.unlockRecovery(recoveryInput.trim());
                setNotice("Recovery storage unlocked on this device.");
              })}><KeyRound />Unlock recovery</button>
            </div>
          )}
          {generatedRecovery ? (
            <div className="recovery-result" role="status">
              <strong>Save this somewhere safe. It will not be shown again.</strong>
              <code>{generatedRecovery}</code>
              <button type="button" onClick={() => void navigator.clipboard.writeText(generatedRecovery)}><Copy />Copy recovery key</button>
            </div>
          ) : null}
          <button className="secondary-button full-width" type="button" disabled={busyAction === "verify"} onClick={() => void act("verify", async () => {
            await service.verifyWithAnotherDevice(async (emojis) => window.confirm(`Do these emoji match your other device?\n\n${emojis.map(([emoji, name]) => `${emoji} ${name}`).join("   ")}\n\nChoose OK only if every emoji matches.`));
            setNotice("This device is verified.");
          })}><ShieldCheck />Verify with another device</button>

          <h3><Users />Devices</h3>
          <div className="device-list">
            {devices.map((device) => (
              <div key={device.deviceId}><span className={device.current ? "status-dot status-dot--online" : "status-dot"} /><span><strong>{device.displayName}{device.current ? " · this device" : ""}</strong><small>{device.deviceId}{device.lastSeenTs ? ` · ${new Date(device.lastSeenTs).toLocaleDateString()}` : ""}</small></span></div>
            ))}
          </div>
          <button className="danger-button" type="button" onClick={() => {
            if (window.confirm("Sign out of Sub-Etha on this device? Local message and encryption stores will be cleared.")) void onLogout();
          }}><LogOut />Sign out and clear this device</button>
        </section>
      </div>
      {notice ? <p className="success-note" role="status">{notice}</p> : null}
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </Dialog>
  );
}
