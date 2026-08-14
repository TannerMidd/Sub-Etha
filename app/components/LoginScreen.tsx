"use client";

import { useState, type SubmitEvent } from "react";
import { ArrowRight, LoaderCircle } from "lucide-react";
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
import { classes } from "../styles/appStyles";

export function LoginScreen({
    onAuthenticated,
    onAuthenticationPendingChange,
}: {
    onAuthenticated: (session: PersistedMatrixSession) => Promise<void> | void;
    onAuthenticationPendingChange?: (pending: boolean) => void;
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

    const passwordLogin = async (event: SubmitEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (!capabilities) {
            return;
        }

        setBusy(true);
        setError(null);
        onAuthenticationPendingChange?.(true);

        try {
            await onAuthenticated(await loginWithPassword(capabilities.baseUrl, userId, password));
        } catch (cause) {
            setError(humanizeMatrixError(cause));
            setBusy(false);
        } finally {
            onAuthenticationPendingChange?.(false);
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
        <main className={classes("login-shell")} data-ui="login-shell">
            <section className={classes("login-intro")} aria-labelledby="welcome-title">
                <BrandMark />
                <div className={classes("login-intro__copy")}>
                    <h1 id="welcome-title">A quiet place to talk.</h1>
                    <p className={classes("lede")}>
                        This browser seals its session credentials and local encryption-store key at
                        rest. End-to-end encrypted rooms protect content for participating devices;
                        optional encrypted key backups can live on your homeserver. Sub-Etha
                        requests event-ID-only notifications using opaque room and event identifiers
                        plus unread counts.
                    </p>
                </div>
                <div className={classes("field-notes")} aria-label="Product principles">
                    <div>
                        <strong>Local vault</strong>
                        <span>Session credentials are sealed at rest.</span>
                    </div>
                    <div>
                        <strong>Works with Matrix</strong>
                        <span>Bring your existing account.</span>
                    </div>
                    <div>
                        <strong>Installable</strong>
                        <span>A proper app, offline included.</span>
                    </div>
                </div>
            </section>

            <section className={classes("login-card")} aria-labelledby="signin-title">
                <div className={classes("login-card__header")}>
                    <h2 id="signin-title">Sign in</h2>
                </div>

                {!capabilities ? (
                    <form
                        onSubmit={(event) => {
                            event.preventDefault();
                            void discover();
                        }}
                        className={classes("login-form login-form--discovery")}
                    >
                        <label htmlFor="homeserver">Matrix ID or homeserver</label>
                        <input
                            id="homeserver"
                            value={serverInput}
                            onChange={(event) => setServerInput(event.target.value)}
                            placeholder="@you:example.org"
                            autoComplete="username"
                            spellCheck={false}
                        />
                        <p className={classes("field-help")}>
                            We use Matrix discovery first, then contact the homeserver directly.
                        </p>
                        <button
                            className={classes("primary-button")}
                            type="submit"
                            disabled={busy || !serverInput.trim()}
                        >
                            {busy ? (
                                <>
                                    <LoaderCircle className={classes("spin")} aria-hidden="true" />{" "}
                                    Consulting the address book…
                                </>
                            ) : (
                                <>
                                    Continue <ArrowRight aria-hidden="true" />
                                </>
                            )}
                        </button>
                    </form>
                ) : (
                    <div className={classes("login-form")}>
                        <button
                            className={classes("server-pill")}
                            type="button"
                            onClick={() => {
                                setCapabilities(null);
                                setError(null);
                            }}
                        >
                            <span>
                                <span className={classes("status-dot status-dot--online")} />
                                {capabilities.serverName}
                            </span>
                            <span>Change</span>
                        </button>

                        {capabilities.oauth ? (
                            <button
                                className={classes("primary-button")}
                                type="button"
                                disabled={busy}
                                onClick={() => void redirect("oauth")}
                            >
                                Continue securely with OAuth
                            </button>
                        ) : null}

                        {capabilities.sso ? (
                            capabilities.identityProviders.length ? (
                                <div
                                    className={classes("provider-list")}
                                    aria-label="Single sign-on providers"
                                >
                                    {capabilities.identityProviders.map((provider) => (
                                        <button
                                            className={classes("secondary-button")}
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
                                    className={classes("secondary-button")}
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void redirect("sso")}
                                >
                                    Continue with single sign-on <ArrowRight aria-hidden="true" />
                                </button>
                            )
                        ) : null}

                        {capabilities.password ? (
                            <form onSubmit={passwordLogin} className={classes("password-fields")}>
                                <div className={classes("divider")}>
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
                                    className={classes("primary-button")}
                                    type="submit"
                                    disabled={busy || !userId.trim() || !password}
                                >
                                    {busy ? (
                                        <>
                                            <LoaderCircle
                                                className={classes("spin")}
                                                aria-hidden="true"
                                            />{" "}
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
                            className={classes("advanced-toggle")}
                            type="button"
                            aria-expanded={advanced}
                            onClick={() => setAdvanced((value) => !value)}
                        >
                            {advanced ? "Hide access token" : "Use an access token"}
                        </button>
                        {advanced ? (
                            <div className={classes("token-fields")}>
                                <label htmlFor="access-token">Existing access token</label>
                                <input
                                    type="password"
                                    id="access-token"
                                    value={accessToken}
                                    onChange={(event) => setAccessToken(event.target.value)}
                                    autoComplete="new-password"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                />
                                <p className={classes("field-help")}>
                                    Sealed in this browser after you save the recovery key. Treat it
                                    like a password.
                                </p>
                                <button
                                    className={classes("secondary-button")}
                                    type="button"
                                    disabled={busy || !accessToken.trim()}
                                    onClick={() => void tokenLogin()}
                                >
                                    Use token
                                </button>
                            </div>
                        ) : null}

                        {!capabilities.oauth && !capabilities.sso && !capabilities.password ? (
                            <p className={classes("inline-notice")}>
                                This homeserver did not advertise a login method Sub-Etha can safely
                                use.
                            </p>
                        ) : null}
                    </div>
                )}

                {error ? (
                    <div className={classes("error-note")} role="alert">
                        <strong>Signal not acquired.</strong>
                        <span>{error}</span>
                    </div>
                ) : null}
                <p className={classes("privacy-footnote")}>
                    Sub-Etha requests event-ID-only pushes; its relay uses only opaque room/event
                    IDs and unread counts, and does not forward message content or sender identity
                    to the browser.
                </p>
            </section>
        </main>
    );
}
