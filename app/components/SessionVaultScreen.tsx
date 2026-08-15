"use client";

import { useState } from "react";
import {
    Check,
    Copy,
    Fingerprint,
    KeyRound,
    LoaderCircle,
    LockKeyhole,
    ShieldCheck,
    Trash2,
} from "lucide-react";
import { BrandMark } from "./BrandMark";
import { classes } from "../styles/appStyles";

type DeviceEnrollmentState = "available" | "pending" | "ready" | "unavailable";

interface EnrollmentProps {
    mode: "enrollment" | "migration";
    recoveryKey: string;
    deviceEnrollment: DeviceEnrollmentState;
    busy: boolean;
    error: string | null;
    onBeginDeviceEnrollment: () => void;
    onCompleteDeviceEnrollment: () => void;
    onContinue: () => void;
    onCancel?: () => void;
    onForget?: () => void;
}

interface LockedProps {
    mode: "locked";
    hasDeviceUnlock: boolean;
    busy: boolean;
    error: string | null;
    onDeviceUnlock: () => void;
    onRecoveryUnlock: (recoveryKey: string) => void;
    onForget: () => void;
}

interface CorruptProps {
    mode: "corrupt";
    busy: boolean;
    error: string | null;
    onForget: () => void;
}

interface CleanupProps {
    mode: "cleanup";
    busy: boolean;
    error: string | null;
    onRetry: () => void;
}

export type SessionVaultScreenProps = EnrollmentProps | LockedProps | CorruptProps | CleanupProps;

function BusyIcon({ busy }: { busy: boolean }) {
    return busy ? (
        <LoaderCircle className={classes("spin")} aria-hidden="true" />
    ) : (
        <ShieldCheck aria-hidden="true" />
    );
}

export function SessionVaultScreen(props: SessionVaultScreenProps) {
    const [confirmation, setConfirmation] = useState("");
    const [recoveryInput, setRecoveryInput] = useState("");
    const [copied, setCopied] = useState(false);
    const [forgetConfirmationMode, setForgetConfirmationMode] = useState<
        SessionVaultScreenProps["mode"] | null
    >(null);

    const confirmForget = () => {
        if (forgetConfirmationMode === props.mode) {
            if (props.mode !== "cleanup") {
                props.onForget?.();
            }

            return;
        }

        setForgetConfirmationMode(props.mode);
    };

    const forgetArmed = forgetConfirmationMode === props.mode;

    if (props.mode === "cleanup") {
        return (
            <main className={classes("boot-screen")}>
                <BrandMark />
                <section className={classes("boot-card boot-card--error")}>
                    <LockKeyhole aria-hidden="true" />
                    <p className={classes("eyebrow")}>LOCAL CLEANUP INCOMPLETE</p>
                    <h1>Sub-Etha has locked the session but could not finish removing its data.</h1>
                    <p>
                        No account will open until the authorized local Matrix stores have been
                        removed. Close any other Sub-Etha tabs, then retry.
                    </p>
                    {props.error ? (
                        <div className={classes("error-note")} role="alert">
                            <strong>Cleanup did not finish.</strong>
                            <span>{props.error}</span>
                        </div>
                    ) : null}
                    <button
                        className={classes("primary-button vault-wide-button")}
                        type="button"
                        disabled={props.busy}
                        onClick={props.onRetry}
                    >
                        <BusyIcon busy={props.busy} />
                        Retry secure cleanup
                    </button>
                </section>
            </main>
        );
    }

    if (props.mode === "corrupt") {
        return (
            <main className={classes("boot-screen")}>
                <BrandMark />
                <section className={classes("boot-card boot-card--error")}>
                    <LockKeyhole aria-hidden="true" />
                    <p className={classes("eyebrow")}>LOCAL VAULT UNAVAILABLE</p>
                    <h1>This browser&apos;s secure session cannot be opened.</h1>
                    <p>
                        The stored record is incomplete, corrupted, or from an unsupported version.
                        It has not been changed.
                    </p>
                    {props.error ? (
                        <div className={classes("error-note")} role="alert">
                            <strong>Local session unavailable.</strong>
                            <span>{props.error}</span>
                        </div>
                    ) : null}
                    <div className={classes("button-row")}>
                        <button
                            className={classes("danger-button")}
                            type="button"
                            disabled={props.busy}
                            onClick={confirmForget}
                        >
                            <Trash2 aria-hidden="true" />
                            {forgetArmed ? "Confirm local reset" : "Forget local session"}
                        </button>
                    </div>
                    <p className={classes("vault-warning")}>
                        This permanently removes all local Sub-Etha Matrix vault, sync, and
                        encryption data this browser can identify. It does not revoke Matrix
                        sessions on the homeserver; use another trusted client to revoke them if
                        this browser may be compromised.
                    </p>
                </section>
            </main>
        );
    }

    if (props.mode === "locked") {
        return (
            <main className={classes("boot-screen")} data-ui="session-vault-locked">
                <BrandMark />
                <section className={classes("boot-card")} aria-labelledby="vault-unlock-title">
                    <LockKeyhole aria-hidden="true" />
                    <p className={classes("eyebrow")}>LOCAL SESSION LOCKED</p>
                    <h1 id="vault-unlock-title">Unlock Sub-Etha on this browser.</h1>
                    <p>
                        Your Matrix credentials and encryption-store key remain sealed until you
                        unlock them. Sub-Etha will ask again after every reload.
                    </p>

                    {props.hasDeviceUnlock ? (
                        <button
                            className={classes("primary-button vault-wide-button")}
                            type="button"
                            disabled={props.busy}
                            onClick={props.onDeviceUnlock}
                        >
                            <Fingerprint aria-hidden="true" />
                            Unlock with this device
                        </button>
                    ) : null}

                    <form
                        className={classes("vault-form")}
                        onSubmit={(event) => {
                            event.preventDefault();
                            props.onRecoveryUnlock(recoveryInput);
                        }}
                    >
                        <label htmlFor="session-recovery-key">Recovery key</label>
                        <input
                            id="session-recovery-key"
                            type="password"
                            name="session-recovery-key"
                            value={recoveryInput}
                            onChange={(event) => setRecoveryInput(event.target.value)}
                            autoComplete="off"
                            spellCheck={false}
                            disabled={props.busy}
                        />
                        <button
                            className={classes("secondary-button")}
                            type="submit"
                            disabled={props.busy || !recoveryInput}
                        >
                            <KeyRound aria-hidden="true" />
                            Unlock with recovery key
                        </button>
                    </form>

                    {props.error ? (
                        <div className={classes("error-note")} role="alert">
                            <strong>Unable to unlock.</strong>
                            <span>{props.error}</span>
                        </div>
                    ) : null}

                    <button
                        className={classes("vault-text-button")}
                        type="button"
                        disabled={props.busy}
                        onClick={confirmForget}
                    >
                        {forgetArmed ? "Confirm local reset" : "Forget this browser"}
                    </button>
                    <p className={classes("vault-warning")}>
                        This permanently removes all local Sub-Etha Matrix session and encryption
                        data. It does not revoke the Matrix session; use another trusted client to
                        revoke it if this browser may be compromised.
                    </p>
                </section>
            </main>
        );
    }

    const confirmed = confirmation === props.recoveryKey;
    const migrating = props.mode === "migration";

    return (
        <main className={classes("boot-screen")} data-ui="session-vault-enrollment">
            <BrandMark />
            <section className={classes("boot-card")} aria-labelledby="vault-enrollment-title">
                <ShieldCheck aria-hidden="true" />
                <p className={classes("eyebrow")}>
                    {migrating ? "SECURE EXISTING SESSION" : "PROTECT THIS BROWSER"}
                </p>
                <h1 id="vault-enrollment-title">Save the recovery key before continuing.</h1>
                <p>
                    Sub-Etha does not save this recovery key in browser storage or alongside the
                    encrypted vault. Losing every unlock method means signing in and restoring
                    Matrix keys again.
                </p>

                <div className={classes("vault-recovery-key")} data-ui="vault-recovery-key">
                    <span>Recovery key</span>
                    <code>{props.recoveryKey}</code>
                    <button
                        className={classes("secondary-button")}
                        type="button"
                        disabled={props.busy}
                        onClick={() => {
                            void navigator.clipboard
                                .writeText(props.recoveryKey)
                                .then(() => setCopied(true))
                                .catch(() => setCopied(false));
                        }}
                    >
                        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                        {copied ? "Copied" : "Copy key"}
                    </button>
                </div>

                <div className={classes("vault-form")}>
                    <label htmlFor="session-recovery-confirmation">
                        Paste the recovery key to confirm you saved it
                    </label>
                    <input
                        id="session-recovery-confirmation"
                        name="session-recovery-confirmation"
                        value={confirmation}
                        onChange={(event) => setConfirmation(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={props.busy}
                    />
                </div>

                {props.deviceEnrollment !== "unavailable" ? (
                    <div className={classes("vault-device-option")}>
                        <div>
                            <strong>Device unlock</strong>
                            <span>
                                Add a biometric, PIN, passkey, or security key for faster unlocks.
                                Passkeys may be synced by your passkey provider. Your recovery key
                                will still work.
                            </span>
                        </div>
                        {props.deviceEnrollment === "ready" ? (
                            <span className={classes("vault-ready-label")}>
                                <Check aria-hidden="true" /> Ready
                            </span>
                        ) : (
                            <button
                                className={classes("secondary-button")}
                                type="button"
                                disabled={props.busy}
                                onClick={
                                    props.deviceEnrollment === "pending"
                                        ? props.onCompleteDeviceEnrollment
                                        : props.onBeginDeviceEnrollment
                                }
                            >
                                <Fingerprint aria-hidden="true" />
                                {props.deviceEnrollment === "pending"
                                    ? "Verify device unlock"
                                    : "Add device unlock"}
                            </button>
                        )}
                    </div>
                ) : null}

                {props.error ? (
                    <div className={classes("error-note")} role="alert">
                        <strong>Secure setup did not finish.</strong>
                        <span>{props.error}</span>
                    </div>
                ) : null}

                <div className={classes("button-row")}>
                    <button
                        className={classes("primary-button")}
                        type="button"
                        disabled={props.busy || !confirmed}
                        onClick={props.onContinue}
                    >
                        <BusyIcon busy={props.busy} />
                        {migrating ? "Encrypt and continue" : "Secure and continue"}
                    </button>
                    {migrating && props.onForget ? (
                        <button
                            className={classes("secondary-button")}
                            type="button"
                            disabled={props.busy}
                            onClick={confirmForget}
                        >
                            {forgetArmed ? "Confirm local reset" : "Forget this browser"}
                        </button>
                    ) : null}
                    {!migrating && props.onCancel ? (
                        <button
                            className={classes("secondary-button")}
                            type="button"
                            disabled={props.busy}
                            onClick={props.onCancel}
                        >
                            Cancel sign-in and revoke session
                        </button>
                    ) : null}
                </div>
                {migrating && props.onForget ? (
                    <p className={classes("vault-warning")}>
                        Forgetting permanently removes the existing local session and encryption
                        store without revoking the Matrix session on the homeserver.
                    </p>
                ) : null}
                {!migrating && props.onCancel ? (
                    <p className={classes("vault-warning")}>
                        Until setup finishes, the new session credentials exist only in this tab,
                        but the Matrix session and device already exist on the homeserver.
                        Cancellation attempts to revoke them. If this browser crashes or is forced
                        closed first, revoke the device from another trusted Matrix client.
                    </p>
                ) : null}
            </section>
        </main>
    );
}
