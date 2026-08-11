"use client";

import { useEffect, useId, useRef, useState } from "react";
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
    ShieldAlert,
    ShieldCheck,
    Sun,
    UserPlus,
    Users,
    X,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import {
    disablePush,
    enablePush,
    refreshPushState,
    sendTestPush,
} from "@/lib/matrix/notifications";
import type {
    DeviceSummary,
    DeviceVerificationState,
    PushState,
    RoomSummary,
    TimelineItem,
} from "@/lib/matrix/types";
import { Avatar } from "./BrandMark";
import { classes } from "../styles/appStyles";

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
    const titleId = useId();

    useEffect(() => {
        const handle = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        window.addEventListener("keydown", handle);
        dialogRef.current?.querySelector<HTMLElement>("[data-dialog-autofocus]")?.focus();

        return () => window.removeEventListener("keydown", handle);
    }, [onClose]);

    return (
        <div
            className={classes("dialog-backdrop")}
            data-ui="dialog-backdrop"
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <section
                ref={dialogRef}
                className={classes(`dialog-card${wide ? " dialog-card--wide" : ""}`)}
                data-ui="dialog-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
            >
                <header className={classes("dialog-card__header")}>
                    <div>
                        {eyebrow ? <p className={classes("eyebrow")}>{eyebrow}</p> : null}
                        <h2 id={titleId}>{title}</h2>
                    </div>
                    <button
                        className={classes("icon-button")}
                        type="button"
                        aria-label="Close"
                        onClick={onClose}
                    >
                        <X />
                    </button>
                </header>
                {children}
            </section>
        </div>
    );
}

export function VerificationDialog({
    verification,
    service,
}: {
    verification: DeviceVerificationState;
    service: MatrixService;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const terminal =
        verification.stage === "complete" ||
        verification.stage === "cancelled" ||
        verification.stage === "error";

    const act = async (action: () => Promise<void>) => {
        setBusy(true);
        setError(null);

        try {
            await action();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Verification failed.");
        } finally {
            setBusy(false);
        }
    };

    const close = () => {
        if (busy) {
            return;
        }

        if (terminal) {
            service.dismissDeviceVerification();
        } else {
            void act(() => service.cancelDeviceVerification());
        }
    };

    const deviceLabel = verification.otherDeviceId || "another signed-in device";

    return (
        <Dialog
            title={
                verification.stage === "comparing"
                    ? "Compare devices"
                    : verification.stage === "complete"
                      ? "Device verified"
                      : "Verify a device"
            }
            eyebrow="SECURE RECEIVER HANDSHAKE"
            onClose={close}
        >
            <div
                className={classes(`verification-flow verification-flow--${verification.stage}`)}
                aria-live="polite"
            >
                <div className={classes("verification-flow__signal")} aria-hidden="true">
                    {verification.stage === "complete" ? (
                        <ShieldCheck />
                    ) : verification.stage === "error" || verification.stage === "cancelled" ? (
                        <ShieldAlert />
                    ) : busy || verification.stage === "waiting" ? (
                        <LoaderCircle className={classes("spin")} />
                    ) : (
                        <ShieldCheck />
                    )}
                </div>

                {verification.stage === "incoming" ? (
                    <>
                        <h3>Verification requested</h3>
                        <p>
                            Another Sub-Etha receiver signed in as{" "}
                            <strong>{verification.otherUserId}</strong> wants to verify this device.
                        </p>
                        <div className={classes("verification-device")}>
                            <span>REQUESTING DEVICE</span>
                            <code>{deviceLabel}</code>
                        </div>
                        <p className={classes("verification-warning")}>
                            Accept only if you just started this from Sub-Etha on your other device.
                        </p>
                        <div className={classes("verification-actions")}>
                            <button
                                className={classes("secondary-button")}
                                type="button"
                                disabled={busy}
                                onClick={() => void act(() => service.cancelDeviceVerification())}
                            >
                                Decline
                            </button>
                            <button
                                className={classes("primary-button")}
                                data-dialog-autofocus
                                type="button"
                                disabled={busy}
                                onClick={() => void act(() => service.acceptDeviceVerification())}
                            >
                                {busy ? (
                                    <LoaderCircle className={classes("spin")} />
                                ) : (
                                    <ShieldCheck />
                                )}
                                Accept &amp; compare
                            </button>
                        </div>
                    </>
                ) : null}

                {verification.stage === "waiting" ? (
                    <>
                        <h3>
                            {verification.direction === "outgoing"
                                ? "Waiting for your other device"
                                : "Establishing a secure link"}
                        </h3>
                        <p>{verification.message}</p>
                        <div className={classes("verification-device")}>
                            <span>OTHER DEVICE</span>
                            <code>{deviceLabel}</code>
                        </div>
                        <p className={classes("verification-help")}>
                            Keep Sub-Etha open on both devices. The emoji comparison will appear
                            here automatically.
                        </p>
                        <button
                            className={classes("secondary-button full-width")}
                            type="button"
                            disabled={busy}
                            onClick={() => void act(() => service.cancelDeviceVerification())}
                        >
                            Cancel verification
                        </button>
                    </>
                ) : null}

                {verification.stage === "comparing" ? (
                    <>
                        <h3>Do these match exactly?</h3>
                        <p>Both Sub-Etha devices must show the same symbols in the same order.</p>
                        {verification.emojis.length ? (
                            <ol
                                className={classes("verification-emoji")}
                                aria-label="Security emoji"
                            >
                                {verification.emojis.map(([emoji, name], index) => (
                                    <li key={`${index}-${name}`}>
                                        <span aria-hidden="true">{emoji}</span>
                                        <small>{name}</small>
                                    </li>
                                ))}
                            </ol>
                        ) : verification.decimals ? (
                            <div
                                className={classes("verification-decimals")}
                                aria-label={`Security numbers ${verification.decimals.join(", ")}`}
                            >
                                {verification.decimals.map((number) => (
                                    <code key={number}>{number}</code>
                                ))}
                            </div>
                        ) : (
                            <p className={classes("inline-error")}>
                                This homeserver did not provide a comparison sequence.
                            </p>
                        )}
                        <p className={classes("verification-warning")}>
                            If even one item differs, choose “They do not match.”
                        </p>
                        <div className={classes("verification-actions")}>
                            <button
                                className={classes("secondary-button")}
                                type="button"
                                disabled={busy}
                                onClick={() =>
                                    void act(() => service.confirmDeviceVerification(false))
                                }
                            >
                                They do not match
                            </button>
                            <button
                                className={classes("primary-button")}
                                data-dialog-autofocus
                                type="button"
                                disabled={
                                    busy || (!verification.emojis.length && !verification.decimals)
                                }
                                onClick={() =>
                                    void act(() => service.confirmDeviceVerification(true))
                                }
                            >
                                {busy ? <LoaderCircle className={classes("spin")} /> : <Check />}
                                They match
                            </button>
                        </div>
                    </>
                ) : null}

                {terminal ? (
                    <>
                        <h3>
                            {verification.stage === "complete"
                                ? "Handshake complete"
                                : verification.stage === "cancelled"
                                  ? "Verification cancelled"
                                  : "Verification failed"}
                        </h3>
                        <p>{verification.message}</p>
                        <button
                            className={classes(
                                verification.stage === "complete"
                                    ? "primary-button full-width"
                                    : "secondary-button full-width",
                            )}
                            data-dialog-autofocus
                            type="button"
                            onClick={() => service.dismissDeviceVerification()}
                        >
                            Done
                        </button>
                    </>
                ) : null}

                {error ? (
                    <p className={classes("inline-error")} role="alert">
                        {error}
                    </p>
                ) : null}
            </div>
        </Dialog>
    );
}

export function NewConversationDialog({
    service,
    onClose,
}: {
    service: MatrixService;
    onClose: () => void;
}) {
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
            if (mode === "join") {
                await service.joinRoom(target);
            } else {
                await service.createRoom({
                    name: mode === "room" ? name : undefined,
                    invite: target,
                    direct: mode === "dm",
                    encrypted,
                });
            }

            onClose();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The room could not be reached.");
            setBusy(false);
        }
    };

    return (
        <Dialog title="Open a channel" eyebrow="NEW TRANSMISSION" onClose={onClose}>
            <div
                className={classes("segmented-control")}
                role="tablist"
                aria-label="Conversation type"
            >
                {(["dm", "room", "join"] as const).map((value) => (
                    <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={mode === value}
                        onClick={() => setMode(value)}
                    >
                        {value === "dm" ? "Direct" : value === "room" ? "Room" : "Join"}
                    </button>
                ))}
            </div>
            <form className={classes("panel-form")} onSubmit={submit}>
                {mode === "room" ? (
                    <>
                        <label htmlFor="room-name">Room name</label>
                        <input
                            id="room-name"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Tea at the end of the universe"
                        />
                    </>
                ) : null}
                <label htmlFor="room-target">
                    {mode === "join"
                        ? "Room alias or ID"
                        : mode === "dm"
                          ? "Matrix user ID"
                          : "Invite someone (optional)"}
                </label>
                <input
                    id="room-target"
                    data-dialog-autofocus
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    placeholder={mode === "join" ? "#room:example.org" : "@friend:example.org"}
                    required={mode !== "room"}
                />
                {mode !== "join" ? (
                    <label className={classes("check-row")}>
                        <input
                            type="checkbox"
                            checked={encrypted}
                            onChange={(event) => setEncrypted(event.target.checked)}
                        />
                        <span>
                            <LockKeyhole />
                            Enable end-to-end encryption
                        </span>
                    </label>
                ) : null}
                {error ? (
                    <p className={classes("inline-error")} role="alert">
                        {error}
                    </p>
                ) : null}
                <button
                    className={classes("primary-button")}
                    type="submit"
                    disabled={busy || (mode !== "room" && !target.trim())}
                >
                    {busy ? (
                        <>
                            <LoaderCircle className={classes("spin")} /> Reticulating room aliases…
                        </>
                    ) : (
                        <>
                            Continue <ChevronRight />
                        </>
                    )}
                </button>
            </form>
        </Dialog>
    );
}

export function SearchDialog({
    service,
    onClose,
}: {
    service: MatrixService;
    onClose: () => void;
}) {
    const [term, setTerm] = useState("");
    const [results, setResults] = useState<TimelineItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const search = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);

        try {
            setResults(await service.searchCurrentRoom(term));
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "Search is not supported by this homeserver.",
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog title="Search this room" eyebrow="MESSAGE INDEX" onClose={onClose} wide>
            <form className={classes("search-form")} onSubmit={search}>
                <Search aria-hidden="true" />
                <label className={classes("sr-only")} htmlFor="room-search-term">
                    Search messages
                </label>
                <input
                    id="room-search-term"
                    data-dialog-autofocus
                    value={term}
                    onChange={(event) => setTerm(event.target.value)}
                    placeholder="A phrase worth finding again"
                />
                <button type="submit" disabled={busy || !term.trim()}>
                    {busy ? <LoaderCircle className={classes("spin")} /> : "Search"}
                </button>
            </form>
            {error ? (
                <div className={classes("error-note")}>
                    <strong>Search unavailable.</strong>
                    <span>{error}</span>
                </div>
            ) : null}
            <div className={classes("search-results")} aria-live="polite">
                {!busy && term && !results.length && !error ? (
                    <p className={classes("empty-note")}>
                        No matching transmissions. The universe remains coy.
                    </p>
                ) : null}
                {results.map((result) => (
                    <button
                        key={result.id}
                        type="button"
                        onClick={() => {
                            window.location.assign(
                                `#/room/${encodeURIComponent(service.getSnapshot().activeRoomId ?? "")}/event/${encodeURIComponent(result.id)}`,
                            );
                            onClose();
                        }}
                    >
                        <Avatar
                            name={result.senderName}
                            mxcUrl={result.senderAvatarMxcUrl}
                            service={service}
                            size="small"
                        />
                        <span>
                            <strong>{result.senderName}</strong>
                            <span>{result.body}</span>
                        </span>
                        <time>
                            {new Intl.DateTimeFormat(undefined, {
                                month: "short",
                                day: "numeric",
                            }).format(result.timestamp)}
                        </time>
                    </button>
                ))}
            </div>
        </Dialog>
    );
}

export function RoomDetailsDialog({
    room,
    service,
    onClose,
}: {
    room: RoomSummary;
    service: MatrixService;
    onClose: () => void;
}) {
    const [invitee, setInvitee] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [muted, setMuted] = useState(room.muted);

    const invite = async (event: React.FormEvent) => {
        event.preventDefault();
        setBusy(true);
        setError(null);

        try {
            await service.invite(invitee);
            setInvitee("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Invitation failed.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog title={room.name} eyebrow="ROOM FIELD NOTES" onClose={onClose}>
            <div className={classes("room-profile")}>
                <Avatar
                    name={room.name}
                    mxcUrl={room.avatarMxcUrl}
                    service={service}
                    size="large"
                />
                <div>
                    <strong>
                        {room.memberCount} {room.memberCount === 1 ? "member" : "members"}
                    </strong>
                    <span>{room.encrypted ? "End-to-end encrypted" : "Not encrypted"}</span>
                </div>
            </div>
            <div className={classes("settings-list")}>
                <button
                    type="button"
                    onClick={async () => {
                        const next = !muted;

                        setMuted(next);
                        await service.setRoomMuted(next);
                    }}
                >
                    {muted ? <BellOff /> : <Bell />}
                    <span>
                        <strong>{muted ? "Notifications muted" : "Notifications on"}</strong>
                        <small>Change alerts for this room</small>
                    </span>
                    <ChevronRight />
                </button>
            </div>
            <form className={classes("panel-form panel-form--inline")} onSubmit={invite}>
                <label htmlFor="invite-user">Invite a Matrix user</label>
                <div>
                    <input
                        id="invite-user"
                        value={invitee}
                        onChange={(event) => setInvitee(event.target.value)}
                        placeholder="@friend:example.org"
                    />
                    <button type="submit" disabled={busy || !invitee.trim()} aria-label="Invite">
                        <UserPlus />
                    </button>
                </div>
            </form>
            {error ? (
                <p className={classes("inline-error")} role="alert">
                    {error}
                </p>
            ) : null}
            <button
                className={classes("danger-button")}
                type="button"
                onClick={async () => {
                    if (
                        window.confirm(
                            `Leave “${room.name}”? You can only return if the room permits it or someone invites you.`,
                        )
                    ) {
                        await service.leaveActiveRoom();
                        onClose();
                    }
                }}
            >
                <DoorOpen />
                Leave room
            </button>
        </Dialog>
    );
}

export function SettingsDialog({
    service,
    onClose,
    onLogout,
    onEraseAll,
    onVerificationStarted,
}: {
    service: MatrixService;
    onClose: () => void;
    onLogout: () => Promise<void>;
    onEraseAll: () => Promise<void>;
    onVerificationStarted: () => void;
}) {
    const snapshot = service.getSnapshot();
    const [displayName, setDisplayName] = useState(snapshot.displayName);
    const [avatar, setAvatar] = useState<File | undefined>();
    const [theme, setTheme] = useState(() => localStorage.getItem("sub-etha-theme") ?? "dark");
    const [pushState, setPushState] = useState<PushState>({
        supported: false,
        enabled: false,
        permission: "unsupported",
        checking: true,
    });
    const [devices, setDevices] = useState<DeviceSummary[]>([]);
    const [cryptoStatus, setCryptoStatus] = useState<{
        secretStorageReady: boolean;
        crossSigningConfigured: boolean;
        crossSigningReady: boolean;
        backupVersion: string | null;
    } | null>(null);
    const [passphrase, setPassphrase] = useState("");
    const [accountPassword, setAccountPassword] = useState("");
    const [recoveryInput, setRecoveryInput] = useState("");
    const [generatedRecovery, setGeneratedRecovery] = useState<string | null>(null);
    const [busyAction, setBusyAction] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        void Promise.all([service.getDevices(), service.getCryptoStatus()])
            .then(([nextDevices, nextCrypto]) => {
                setDevices(nextDevices);
                setCryptoStatus(nextCrypto);
            })
            .catch(() => undefined);
    }, [service]);

    useEffect(() => {
        let active = true;

        void refreshPushState(service).then((state) => {
            if (active) {
                setPushState(state);
            }
        });

        return () => {
            active = false;
        };
    }, [service]);

    const act = async (name: string, action: () => Promise<void>) => {
        setBusyAction(name);
        setError(null);
        setNotice(null);

        try {
            await action();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The operation failed.");
        } finally {
            setBusyAction(null);
        }
    };

    const setThemeChoice = (value: string) => {
        setTheme(value);
        localStorage.setItem("sub-etha-theme", value);

        if (value === "system") {
            document.documentElement.setAttribute("data-theme", "system");
        } else {
            document.documentElement.setAttribute("data-theme", value);
        }
    };

    return (
        <Dialog title="Settings" eyebrow="DEVICE & ACCOUNT" onClose={onClose} wide>
            <div className={classes("settings-grid")}>
                <section>
                    <h3>
                        <Users />
                        Profile
                    </h3>
                    <form
                        className={classes("panel-form")}
                        onSubmit={(event) => {
                            event.preventDefault();
                            void act("profile", async () => {
                                await service.updateProfile(displayName, avatar);
                                setNotice("Profile updated.");
                            });
                        }}
                    >
                        <div className={classes("profile-preview")}>
                            <Avatar
                                name={displayName || snapshot.userId}
                                mxcUrl={snapshot.avatarMxcUrl}
                                service={service}
                                size="large"
                            />
                            <span>
                                <strong>{displayName || snapshot.userId}</strong>
                                <small>{snapshot.userId}</small>
                            </span>
                        </div>
                        <label htmlFor="display-name">Display name</label>
                        <input
                            id="display-name"
                            value={displayName}
                            onChange={(event) => setDisplayName(event.target.value)}
                        />
                        <label htmlFor="avatar-file">Profile picture</label>
                        <input
                            id="avatar-file"
                            type="file"
                            accept="image/*"
                            onChange={(event) => setAvatar(event.target.files?.[0])}
                        />
                        <button
                            className={classes("secondary-button")}
                            type="submit"
                            disabled={busyAction === "profile"}
                        >
                            {busyAction === "profile" ? (
                                <LoaderCircle className={classes("spin")} />
                            ) : (
                                <Check />
                            )}
                            Save profile
                        </button>
                    </form>

                    <h3>
                        <Sun />
                        Appearance
                    </h3>
                    <div className={classes("theme-options")} role="radiogroup" aria-label="Theme">
                        {[
                            { value: "system", label: "System", icon: Settings },
                            { value: "light", label: "Light", icon: Sun },
                            { value: "dark", label: "Dark", icon: Moon },
                        ].map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                role="radio"
                                aria-checked={theme === option.value}
                                onClick={() => setThemeChoice(option.value)}
                            >
                                <option.icon />
                                {option.label}
                                {theme === option.value ? <Check /> : null}
                            </button>
                        ))}
                    </div>

                    <h3>
                        <Bell />
                        Notifications
                    </h3>
                    <div className={classes("settings-block")}>
                        <div>
                            <strong>Closed-app notifications</strong>
                            <p>
                                Generic alerts only. The gateway never receives message text, sender
                                or room names.
                            </p>
                            {service.storageMode === "private" ? (
                                <p className={classes("inline-notice")}>
                                    Closed-app push requires durable device state and is disabled
                                    for this private session.
                                </p>
                            ) : null}
                        </div>
                        <button
                            className={classes("secondary-button")}
                            type="button"
                            disabled={
                                service.storageMode === "private" ||
                                !pushState.supported ||
                                pushState.checking ||
                                busyAction === "push"
                            }
                            onClick={() =>
                                void act("push", async () => {
                                    setPushState(
                                        pushState.enabled
                                            ? await disablePush(service)
                                            : await enablePush(service),
                                    );
                                })
                            }
                        >
                            {pushState.checking ? (
                                <>
                                    <LoaderCircle className={classes("spin")} />
                                    Checking
                                </>
                            ) : pushState.enabled ? (
                                <>
                                    <BellOff />
                                    Disable
                                </>
                            ) : (
                                <>
                                    <Bell />
                                    Enable
                                </>
                            )}
                        </button>
                        {pushState.enabled ? (
                            <button
                                className={classes("secondary-button")}
                                type="button"
                                disabled={busyAction === "push-test"}
                                onClick={() =>
                                    void act("push-test", async () => {
                                        await sendTestPush();
                                        setNotice(
                                            "Test notification sent. It should appear on this device momentarily.",
                                        );
                                    })
                                }
                            >
                                {busyAction === "push-test" ? (
                                    <LoaderCircle className={classes("spin")} />
                                ) : (
                                    <Bell />
                                )}
                                Send test
                            </button>
                        ) : null}
                        {pushState.permission === "denied" ? (
                            <p className={classes("inline-error")}>
                                Notifications are blocked in browser settings.
                            </p>
                        ) : null}
                        {pushState.error ? (
                            <p className={classes("inline-error")}>{pushState.error}</p>
                        ) : null}
                    </div>
                </section>

                <section>
                    <h3>
                        <ShieldCheck />
                        Encryption & recovery
                    </h3>
                    <div className={classes("crypto-status")}>
                        <span
                            className={classes(cryptoStatus?.secretStorageReady ? "is-ready" : "")}
                        >
                            {cryptoStatus?.secretStorageReady ? <Check /> : <KeyRound />}Secret
                            storage
                        </span>
                        <span
                            className={classes(cryptoStatus?.crossSigningReady ? "is-ready" : "")}
                        >
                            {cryptoStatus?.crossSigningReady ? <Check /> : <KeyRound />}
                            Cross-signing
                        </span>
                        <span className={classes(cryptoStatus?.backupVersion ? "is-ready" : "")}>
                            {cryptoStatus?.backupVersion ? <Check /> : <KeyRound />}Key backup
                        </span>
                    </div>
                    {!cryptoStatus?.secretStorageReady ? (
                        <div className={classes("settings-block")}>
                            <label htmlFor="recovery-passphrase">
                                Optional recovery passphrase
                            </label>
                            <input
                                id="recovery-passphrase"
                                type="password"
                                value={passphrase}
                                onChange={(event) => setPassphrase(event.target.value)}
                                placeholder="Leave blank for a recovery key"
                            />
                            {cryptoStatus && !cryptoStatus.crossSigningConfigured ? (
                                <>
                                    <label htmlFor="matrix-account-password">
                                        Matrix account password
                                    </label>
                                    <input
                                        id="matrix-account-password"
                                        type="password"
                                        value={accountPassword}
                                        onChange={(event) => setAccountPassword(event.target.value)}
                                        placeholder="Needed once if your homeserver asks"
                                        autoComplete="current-password"
                                    />
                                    <p className={classes("verification-help")}>
                                        Used only to authorize cross-signing setup. Sub-Etha never
                                        stores this password.
                                    </p>
                                </>
                            ) : null}
                            <button
                                className={classes("secondary-button")}
                                type="button"
                                disabled={busyAction === "recovery"}
                                onClick={() =>
                                    void act("recovery", async () => {
                                        const key = await service.setupRecovery(
                                            passphrase,
                                            accountPassword || undefined,
                                        );

                                        setGeneratedRecovery(key);
                                        setAccountPassword("");
                                        setCryptoStatus(await service.getCryptoStatus());
                                    })
                                }
                            >
                                <LockKeyhole />
                                Set up recovery
                            </button>
                        </div>
                    ) : (
                        <div className={classes("settings-block")}>
                            <label htmlFor="recovery-key">Recovery key or passphrase</label>
                            <textarea
                                id="recovery-key"
                                rows={3}
                                value={recoveryInput}
                                onChange={(event) => setRecoveryInput(event.target.value)}
                            />
                            <button
                                className={classes("secondary-button")}
                                type="button"
                                disabled={!recoveryInput.trim() || busyAction === "unlock"}
                                onClick={() =>
                                    void act("unlock", async () => {
                                        await service.unlockRecovery(recoveryInput.trim());
                                        setNotice("Recovery storage unlocked on this device.");
                                    })
                                }
                            >
                                <KeyRound />
                                Unlock recovery
                            </button>
                        </div>
                    )}
                    {generatedRecovery ? (
                        <div className={classes("recovery-result")} role="status">
                            <strong>Save this somewhere safe. It will not be shown again.</strong>
                            <code>{generatedRecovery}</code>
                            <button
                                type="button"
                                onClick={() =>
                                    void navigator.clipboard.writeText(generatedRecovery)
                                }
                            >
                                <Copy />
                                Copy recovery key
                            </button>
                        </div>
                    ) : null}
                    <button
                        className={classes("secondary-button full-width")}
                        type="button"
                        disabled={busyAction === "verify" || !cryptoStatus?.crossSigningConfigured}
                        onClick={() =>
                            void act("verify", async () => {
                                await service.startDeviceVerification();
                                onVerificationStarted();
                            })
                        }
                    >
                        <ShieldCheck />
                        Verify with another device
                    </button>
                    {cryptoStatus && !cryptoStatus.crossSigningConfigured ? (
                        <p className={classes("verification-help")}>
                            Set up recovery above to create this account&apos;s cross-signing
                            identity before verifying another device.
                        </p>
                    ) : null}

                    <h3>
                        <Users />
                        Devices
                    </h3>
                    <div className={classes("device-list")}>
                        {devices.map((device) => (
                            <div key={device.deviceId}>
                                <span
                                    className={classes(
                                        device.current
                                            ? "status-dot status-dot--online"
                                            : "status-dot",
                                    )}
                                />
                                <span>
                                    <strong>
                                        {device.displayName}
                                        {device.current ? " · this device" : ""}
                                    </strong>
                                    <small>
                                        {device.deviceId}
                                        {device.lastSeenTs
                                            ? ` · ${new Date(device.lastSeenTs).toLocaleDateString()}`
                                            : ""}
                                    </small>
                                    <small
                                        className={classes(
                                            device.verified
                                                ? "device-trust device-trust--verified"
                                                : "device-trust",
                                        )}
                                    >
                                        {device.verified ? "Verified" : "Not verified"}
                                    </small>
                                </span>
                                {!device.current && !device.verified ? (
                                    <button
                                        type="button"
                                        disabled={
                                            busyAction === `verify-${device.deviceId}` ||
                                            !cryptoStatus?.crossSigningConfigured
                                        }
                                        onClick={() =>
                                            void act(`verify-${device.deviceId}`, async () => {
                                                await service.startDeviceVerification(
                                                    device.deviceId,
                                                );
                                                onVerificationStarted();
                                            })
                                        }
                                    >
                                        Verify
                                    </button>
                                ) : null}
                            </div>
                        ))}
                    </div>
                    <button
                        className={classes("danger-button")}
                        type="button"
                        onClick={() => void onEraseAll()}
                    >
                        <ShieldAlert />
                        Erase all Sub-Etha data
                    </button>
                    <button
                        className={classes("danger-button")}
                        type="button"
                        onClick={() => {
                            if (
                                window.confirm(
                                    "Sign out of Sub-Etha on this device? Local message and encryption stores will be cleared.",
                                )
                            ) {
                                void onLogout();
                            }
                        }}
                    >
                        <LogOut />
                        Sign out and clear this device
                    </button>
                </section>
            </div>
            {notice ? (
                <p className={classes("success-note")} role="status">
                    {notice}
                </p>
            ) : null}
            {error ? (
                <p className={classes("inline-error")} role="alert">
                    {error}
                </p>
            ) : null}
        </Dialog>
    );
}
