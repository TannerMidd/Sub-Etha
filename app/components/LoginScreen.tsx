"use client";

import { useState } from "react";
import {
    ArrowRight,
    Check,
    ChevronDown,
    KeyRound,
    LoaderCircle,
    LockKeyhole,
    Radio,
    Server,
    ShieldCheck,
} from "lucide-react";
import {
    beginOAuth,
    beginSso,
    humanizeMatrixError,
    inspectLoginCapabilities,
    loginWithAccessToken,
    loginWithPassword,
} from "@/lib/matrix/auth";
import type { LoginCapabilities, PersistedMatrixSession } from "@/lib/matrix/types";
import { BrandMark } from "./BrandMark";

export function LoginScreen({
    onAuthenticated,
}: {
    onAuthenticated: (session: PersistedMatrixSession) => Promise<void> | void;
}) {
    const [serverInput, setServerInput] = useState("");
    const [capabilities, setCapabilities] = useState<LoginCapabilities | null>(null);
    const [userId, setUserId] = useState("");
    const [password, setPassword] = useState("");
    const [accessToken, setAccessToken] = useState("");
    const [advanced, setAdvanced] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const discover = async () => {
        setBusy(true);
        setError(null);

        try {
            setCapabilities(await inspectLoginCapabilities(serverInput));
        } catch (cause) {
            setCapabilities(null);
            setError(humanizeMatrixError(cause));
        } finally {
            setBusy(false);
        }
    };

    const passwordLogin = async (event: React.FormEvent) => {
        event.preventDefault();

        if (!capabilities) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            await onAuthenticated(await loginWithPassword(capabilities.baseUrl, userId, password));
        } catch (cause) {
            setError(humanizeMatrixError(cause));
            setBusy(false);
        }
    };

    const tokenLogin = async () => {
        if (!capabilities) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            await onAuthenticated(
                await loginWithAccessToken(capabilities.baseUrl, accessToken.trim()),
            );
        } catch (cause) {
            setError(humanizeMatrixError(cause));
            setBusy(false);
        }
    };

    const redirect = async (kind: "oauth" | "sso", providerId?: string) => {
        if (!capabilities) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            if (kind === "oauth") {
                await beginOAuth(capabilities.baseUrl);
            } else {
                await beginSso(capabilities.baseUrl, providerId);
            }
        } catch (cause) {
            setError(humanizeMatrixError(cause));
            setBusy(false);
        }
    };

    return (
        <main className="login-shell">
            <section className="login-intro" aria-labelledby="welcome-title">
                <BrandMark />
                <div className="login-intro__copy">
                    <p className="eyebrow">AN INDEPENDENT MATRIX RECEIVER</p>
                    <h1 id="welcome-title">Chat without the administrative weather system.</h1>
                    <p className="lede">
                        Your rooms, messages and encryption stay between this device and your Matrix
                        homeserver. Sub-Etha merely makes the controls less alarming.
                    </p>
                </div>
                <div className="field-notes" aria-label="Product principles">
                    <div>
                        <ShieldCheck aria-hidden="true" />
                        <span>
                            <strong>Private by design</strong>Keys remain on this device.
                        </span>
                    </div>
                    <div>
                        <Radio aria-hidden="true" />
                        <span>
                            <strong>Works with Matrix</strong>Bring your existing account.
                        </span>
                    </div>
                    <div>
                        <Check aria-hidden="true" />
                        <span>
                            <strong>Calmly installable</strong>A proper PWA, not a browser-shaped
                            apology.
                        </span>
                    </div>
                </div>
                <p className="edition-note">
                    SUB—ETHA FIELD GUIDE / TRANSMISSION APPARATUS / EARTH SECTOR
                </p>
            </section>

            <section className="login-card" aria-labelledby="signin-title">
                <div className="login-card__header">
                    <span className="index-chip">01</span>
                    <div>
                        <p className="eyebrow">FIND YOUR SIGNAL</p>
                        <h2 id="signin-title">Connect to Matrix</h2>
                    </div>
                </div>

                {!capabilities ? (
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void discover();
                        }}
                        className="login-form"
                    >
                        <label htmlFor="homeserver">Matrix ID or homeserver</label>
                        <div className="field-with-icon">
                            <Server aria-hidden="true" />
                            <input
                                id="homeserver"
                                value={serverInput}
                                onChange={(event) => setServerInput(event.target.value)}
                                placeholder="@you:example.org or matrix.org"
                                autoComplete="username"
                                spellCheck={false}
                            />
                        </div>
                        <p className="field-help">
                            We use Matrix discovery first, then contact the homeserver directly.
                        </p>
                        <button
                            className="primary-button"
                            type="submit"
                            disabled={busy || !serverInput.trim()}
                        >
                            {busy ? (
                                <>
                                    <LoaderCircle className="spin" aria-hidden="true" /> Consulting
                                    the address book…
                                </>
                            ) : (
                                <>
                                    Continue <ArrowRight aria-hidden="true" />
                                </>
                            )}
                        </button>
                    </form>
                ) : (
                    <div className="login-form">
                        <button
                            className="server-pill"
                            type="button"
                            onClick={() => {
                                setCapabilities(null);
                                setError(null);
                            }}
                        >
                            <span>
                                <span className="status-dot status-dot--online" />
                                {capabilities.serverName}
                            </span>
                            <span>Change</span>
                        </button>

                        {capabilities.oauth ? (
                            <button
                                className="primary-button"
                                type="button"
                                disabled={busy}
                                onClick={() => void redirect("oauth")}
                            >
                                <LockKeyhole aria-hidden="true" /> Continue securely with OAuth
                            </button>
                        ) : null}

                        {capabilities.sso ? (
                            capabilities.identityProviders.length ? (
                                <div
                                    className="provider-list"
                                    aria-label="Single sign-on providers"
                                >
                                    {capabilities.identityProviders.map((provider) => (
                                        <button
                                            className="secondary-button"
                                            type="button"
                                            key={provider.id}
                                            disabled={busy}
                                            onClick={() => void redirect("sso", provider.id)}
                                        >
                                            Continue with {provider.name}
                                            <ArrowRight aria-hidden="true" />
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <button
                                    className="secondary-button"
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void redirect("sso")}
                                >
                                    Continue with single sign-on <ArrowRight aria-hidden="true" />
                                </button>
                            )
                        ) : null}

                        {capabilities.password ? (
                            <form onSubmit={passwordLogin} className="password-fields">
                                <div className="divider">
                                    <span>or use a password</span>
                                </div>
                                <label htmlFor="matrix-user">Matrix ID or username</label>
                                <input
                                    id="matrix-user"
                                    value={userId}
                                    onChange={(event) => setUserId(event.target.value)}
                                    autoComplete="username"
                                    placeholder="@you:example.org"
                                />
                                <label htmlFor="matrix-password">Password</label>
                                <input
                                    id="matrix-password"
                                    type="password"
                                    value={password}
                                    onChange={(event) => setPassword(event.target.value)}
                                    autoComplete="current-password"
                                />
                                <button
                                    className="primary-button"
                                    type="submit"
                                    disabled={busy || !userId.trim() || !password}
                                >
                                    {busy ? (
                                        <>
                                            <LoaderCircle className="spin" aria-hidden="true" />{" "}
                                            Establishing contact…
                                        </>
                                    ) : (
                                        <>
                                            Sign in <ArrowRight aria-hidden="true" />
                                        </>
                                    )}
                                </button>
                            </form>
                        ) : null}

                        <button
                            className="advanced-toggle"
                            type="button"
                            aria-expanded={advanced}
                            onClick={() => setAdvanced((value) => !value)}
                        >
                            <KeyRound aria-hidden="true" /> Advanced access token{" "}
                            <ChevronDown className={advanced ? "rotate" : ""} aria-hidden="true" />
                        </button>
                        {advanced ? (
                            <div className="token-fields">
                                <label htmlFor="access-token">Existing access token</label>
                                <textarea
                                    id="access-token"
                                    value={accessToken}
                                    onChange={(event) => setAccessToken(event.target.value)}
                                    rows={3}
                                    spellCheck={false}
                                />
                                <p className="field-help">
                                    Stored only in this browser. Treat it like a password.
                                </p>
                                <button
                                    className="secondary-button"
                                    type="button"
                                    disabled={busy || !accessToken.trim()}
                                    onClick={() => void tokenLogin()}
                                >
                                    Use token
                                </button>
                            </div>
                        ) : null}

                        {!capabilities.oauth && !capabilities.sso && !capabilities.password ? (
                            <p className="inline-notice">
                                This homeserver did not advertise a login method Sub-Etha can safely
                                use.
                            </p>
                        ) : null}
                    </div>
                )}

                {error ? (
                    <div className="error-note" role="alert">
                        <strong>Signal not acquired.</strong>
                        <span>{error}</span>
                    </div>
                ) : null}
                <p className="privacy-footnote">
                    No account data is sent to Sub-Etha’s notification service. Not even the
                    surprisingly unhelpful bits.
                </p>
            </section>
        </main>
    );
}
