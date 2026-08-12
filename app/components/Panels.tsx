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
    Search,
    ShieldAlert,
    ShieldCheck,
    UserPlus,
    X,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import {
    disablePush,
    enablePush,
    readPushState,
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
    variant,
}: {
    title: string;
    eyebrow?: string;
    onClose: () => void;
    children: React.ReactNode;
    wide?: boolean;
    variant?: "settings";
}) {
    const dialogRef = useRef<HTMLElement>(null);
    const onCloseRef = useRef(onClose);
    const titleId = useId();

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        const previousFocus =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        const dialog = dialogRef.current;
        const focusableSelector = [
            "button:not([disabled])",
            "a[href]",
            "input:not([disabled]):not([type='hidden'])",
            "select:not([disabled])",
            "textarea:not([disabled])",
            "[tabindex]:not([tabindex='-1'])",
        ].join(",");
        const getFocusable = () =>
            Array.from(dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? []).filter(
                (element) => element.getClientRects().length > 0,
            );

        const handle = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                onCloseRef.current();

                return;
            }

            if (event.key !== "Tab") {
                return;
            }

            const focusable = getFocusable();

            if (!focusable.length) {
                event.preventDefault();
                dialog?.focus();

                return;
            }

            const first = focusable[0];
            const last = focusable.at(-1)!;
            const active = document.activeElement;

            if (event.shiftKey && (active === first || !dialog?.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (active === last || !dialog?.contains(active))) {
                event.preventDefault();
                first.focus();
            }
        };

        window.addEventListener("keydown", handle);
        const initialFocus =
            dialog?.querySelector<HTMLElement>("[data-dialog-autofocus]") ??
            getFocusable()[0] ??
            dialog;

        initialFocus?.focus();

        return () => {
            window.removeEventListener("keydown", handle);

            if (previousFocus?.isConnected) {
                previousFocus.focus();
            }
        };
    }, []);

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
                className={classes(
                    `dialog-card${wide ? " dialog-card--wide" : ""}${variant ? ` dialog-card--${variant}` : ""}`,
                )}
                data-ui="dialog-card"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
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
                        {variant === "settings" ? "Close" : <X />}
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
                role="group"
                aria-label="Conversation type"
            >
                {(["dm", "room", "join"] as const).map((value) => (
                    <button
                        key={value}
                        type="button"
                        aria-pressed={mode === value}
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
                <div className={classes("error-note")} role="alert">
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
    onVerificationStarted,
}: {
    service: MatrixService;
    onClose: () => void;
    onLogout: () => Promise<void>;
    onVerificationStarted: () => void;
}) {
    const snapshot = service.getSnapshot();
    const settingsPreview =
        new URLSearchParams(window.location.search).get("surface-preview") === "settings";
    const [displayName, setDisplayName] = useState(snapshot.displayName);
    const [avatar, setAvatar] = useState<File | undefined>();
    const [theme, setTheme] = useState(() => localStorage.getItem("sub-etha-theme") ?? "dark");
    const [pushState, setPushState] = useState<PushState>(() =>
        settingsPreview
            ? { supported: true, enabled: true, permission: "granted", checking: false }
            : readPushState(),
    );
    const [devices, setDevices] = useState<DeviceSummary[]>([]);
    const [cryptoStatus, setCryptoStatus] = useState<{
        secretStorageReady: boolean;
        crossSigningReady: boolean;
        backupVersion: string | null;
    } | null>(null);
    const [passphrase, setPassphrase] = useState("");
    const [recoveryInput, setRecoveryInput] = useState("");
    const [generatedRecovery, setGeneratedRecovery] = useState<string | null>(null);
    const [recoveryExpanded, setRecoveryExpanded] = useState(false);
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
        if (settingsPreview) {
            return;
        }

        let active = true;

        void refreshPushState(service).then((state) => {
            if (active) {
                setPushState(state);
            }
        });

        return () => {
            active = false;
        };
    }, [service, settingsPreview]);

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

    const currentDevice = devices.find((device) => device.current);

    return (
        <Dialog title="Settings" onClose={onClose} wide variant="settings">
            <div className={classes("settings-sheet")}>
                <section aria-labelledby="settings-profile-heading">
                    <h3 id="settings-profile-heading">Profile</h3>
                    <form
                        className={classes("settings-profile")}
                        onSubmit={(event) => {
                            event.preventDefault();
                            void act("profile", async () => {
                                await service.updateProfile(displayName, avatar);
                                setNotice("Profile updated.");
                            });
                        }}
                    >
                        <div className={classes("settings-row")}>
                            <label htmlFor="display-name">Display name</label>
                            <input
                                id="display-name"
                                value={displayName}
                                onChange={(event) => setDisplayName(event.target.value)}
                            />
                            {displayName !== snapshot.displayName ? (
                                <button type="submit" disabled={busyAction === "profile"}>
                                    {busyAction === "profile" ? "Saving" : "Save"}
                                </button>
                            ) : null}
                        </div>
                        <div className={classes("settings-row")}>
                            <span>Matrix ID</span>
                            <output>{snapshot.userId}</output>
                        </div>
                        <div className={classes("settings-row settings-row--picture")}>
                            <span>Picture</span>
                            <Avatar
                                name={displayName || snapshot.userId}
                                mxcUrl={snapshot.avatarMxcUrl}
                                service={service}
                                size="medium"
                            />
                            <label
                                className={classes("settings-text-action")}
                                htmlFor="avatar-file"
                            >
                                Replace
                            </label>
                            <input
                                className={classes("settings-file-input")}
                                id="avatar-file"
                                type="file"
                                accept="image/*"
                                onChange={(event) => {
                                    const file = event.target.files?.[0];

                                    setAvatar(file);

                                    if (file) {
                                        void act("profile", async () => {
                                            await service.updateProfile(displayName, file);
                                            setNotice("Profile updated.");
                                        });
                                    }
                                }}
                            />
                        </div>
                    </form>
                </section>

                <section aria-labelledby="settings-appearance-heading">
                    <h3 id="settings-appearance-heading">Appearance</h3>
                    <div className={classes("settings-row")}>
                        <span>Theme</span>
                        <div
                            className={classes("settings-theme-options")}
                            role="group"
                            aria-label="Theme"
                        >
                            {[
                                { value: "dark", label: "Dark" },
                                { value: "light", label: "Light" },
                                { value: "system", label: "System" },
                            ].map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    aria-pressed={theme === option.value}
                                    onClick={() => setThemeChoice(option.value)}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className={classes("settings-row settings-row--notifications")}>
                        <span>Notifications</span>
                        <p>Generic alerts only. No message text leaves your device.</p>
                        <div className={classes("settings-row__actions")}>
                            {pushState.enabled ? (
                                <button
                                    className={classes("settings-row__secondary-action")}
                                    type="button"
                                    disabled={busyAction === "push-test"}
                                    onClick={() =>
                                        void act("push-test", async () => {
                                            await sendTestPush();
                                            setNotice("Test notification sent.");
                                        })
                                    }
                                >
                                    Test
                                </button>
                            ) : null}
                            <button
                                type="button"
                                disabled={
                                    !pushState.supported ||
                                    pushState.checking ||
                                    busyAction === "push"
                                }
                                aria-pressed={pushState.enabled}
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
                                {pushState.checking ? "Checking" : pushState.enabled ? "On" : "Off"}
                            </button>
                        </div>
                    </div>
                    {pushState.permission === "denied" ? (
                        <p className={classes("inline-error")}>
                            Notifications are blocked in browser settings.
                        </p>
                    ) : null}
                    {pushState.error ? (
                        <p className={classes("inline-error")}>{pushState.error}</p>
                    ) : null}
                </section>

                <section aria-labelledby="settings-encryption-heading">
                    <h3 id="settings-encryption-heading">Encryption</h3>
                    <div className={classes("settings-row settings-row--recovery")}>
                        <span>Recovery</span>
                        <p>
                            {cryptoStatus?.secretStorageReady && cryptoStatus.crossSigningReady
                                ? "Secret storage, cross-signing and key backup are active."
                                : "Finish recovery setup to protect your encrypted history."}
                        </p>
                        <button
                            type="button"
                            aria-expanded={recoveryExpanded}
                            onClick={() => setRecoveryExpanded((value) => !value)}
                        >
                            {recoveryExpanded ? "Done" : "Manage"}
                        </button>
                    </div>

                    {recoveryExpanded ? (
                        <div className={classes("settings-recovery-panel")}>
                            <div className={classes("crypto-status")}>
                                <span
                                    className={classes(
                                        cryptoStatus?.secretStorageReady ? "is-ready" : "",
                                    )}
                                >
                                    {cryptoStatus?.secretStorageReady ? <Check /> : <KeyRound />}
                                    Secret storage
                                </span>
                                <span
                                    className={classes(
                                        cryptoStatus?.crossSigningReady ? "is-ready" : "",
                                    )}
                                >
                                    {cryptoStatus?.crossSigningReady ? <Check /> : <KeyRound />}
                                    Cross-signing
                                </span>
                                <span
                                    className={classes(
                                        cryptoStatus?.backupVersion ? "is-ready" : "",
                                    )}
                                >
                                    {cryptoStatus?.backupVersion ? <Check /> : <KeyRound />}
                                    Key backup
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
                                    <button
                                        className={classes("secondary-button")}
                                        type="button"
                                        disabled={busyAction === "recovery"}
                                        onClick={() =>
                                            void act("recovery", async () => {
                                                const key = await service.setupRecovery(passphrase);

                                                setGeneratedRecovery(key);
                                                setCryptoStatus(await service.getCryptoStatus());
                                            })
                                        }
                                    >
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
                                                setNotice(
                                                    "Recovery storage unlocked on this device.",
                                                );
                                            })
                                        }
                                    >
                                        Unlock recovery
                                    </button>
                                </div>
                            )}
                            {generatedRecovery ? (
                                <div className={classes("recovery-result")} role="status">
                                    <strong>
                                        Save this somewhere safe. It will not be shown again.
                                    </strong>
                                    <code>{generatedRecovery}</code>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            void navigator.clipboard.writeText(generatedRecovery)
                                        }
                                    >
                                        <Copy /> Copy recovery key
                                    </button>
                                </div>
                            ) : null}
                            <button
                                className={classes("secondary-button")}
                                type="button"
                                disabled={busyAction === "verify"}
                                onClick={() =>
                                    void act("verify", async () => {
                                        await service.startDeviceVerification();
                                        onVerificationStarted();
                                    })
                                }
                            >
                                Verify with another device
                            </button>
                            {devices.some((device) => !device.current) ? (
                                <div className={classes("device-list")}>
                                    {devices
                                        .filter((device) => !device.current)
                                        .map((device) => (
                                            <div key={device.deviceId}>
                                                <span className={classes("status-dot")} />
                                                <span>
                                                    <strong>{device.displayName}</strong>
                                                    <small>{device.deviceId}</small>
                                                    <small>
                                                        {device.verified
                                                            ? "Verified"
                                                            : "Not verified"}
                                                    </small>
                                                </span>
                                                {!device.verified ? (
                                                    <button
                                                        type="button"
                                                        disabled={
                                                            busyAction ===
                                                            `verify-${device.deviceId}`
                                                        }
                                                        onClick={() =>
                                                            void act(
                                                                `verify-${device.deviceId}`,
                                                                async () => {
                                                                    await service.startDeviceVerification(
                                                                        device.deviceId,
                                                                    );
                                                                    onVerificationStarted();
                                                                },
                                                            )
                                                        }
                                                    >
                                                        Verify
                                                    </button>
                                                ) : null}
                                            </div>
                                        ))}
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    <div className={classes("settings-row settings-row--device")}>
                        <span>This device</span>
                        <p>
                            {currentDevice?.deviceId ?? snapshot.deviceId} ·{" "}
                            {currentDevice?.verified === false ? "not verified" : "verified"}
                        </p>
                        <button
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
                            Sign out
                        </button>
                    </div>
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
