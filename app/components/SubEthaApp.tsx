"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { LoaderCircle, RadioTower, RefreshCw, ShieldAlert } from "lucide-react";
import { completeRedirectLogin, humanizeMatrixError } from "@/lib/matrix/auth";
import type { MatrixService } from "@/lib/matrix/client";
import { clearPushForReset, disablePush, registerServiceWorker } from "@/lib/matrix/notifications";
import { eraseAllSubEthaData, retryPendingCleanup } from "@/lib/matrix/storage-cleanup";
import { clearSession, readSession, saveSession } from "@/lib/matrix/session-store";
import type { CleanupOutcome, PersistedMatrixSession } from "@/lib/matrix/types";
import { assertAllowedHomeserverUrl, InsecureHomeserverError } from "@/lib/matrix/url-policy";
import { BrandMark } from "./BrandMark";
import { ChatShell } from "./ChatShell";
import { DesignPreview } from "./DesignPreview";
import { LoginScreen } from "./LoginScreen";
import styles from "../styles/App.module.scss";
import { classes, configureStyles } from "../styles/appStyles";

configureStyles(styles);

type BootState = "booting" | "login" | "connected" | "duplicate" | "error";

const subscribeToPreviewFlag = (onStoreChange: () => void) => {
    const refresh = () => onStoreChange();
    const hydrationTimer = window.setTimeout(refresh, 0);

    window.addEventListener("popstate", refresh);
    window.addEventListener("hashchange", refresh);

    return () => {
        window.clearTimeout(hydrationTimer);
        window.removeEventListener("popstate", refresh);
        window.removeEventListener("hashchange", refresh);
    };
};

const readPreviewFlag = () =>
    ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) &&
    new URLSearchParams(window.location.search).has("design-preview");

export function SubEthaApp() {
    const [bootState, setBootState] = useState<BootState>("booting");
    const [service, setService] = useState<MatrixService | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [failedRememberedSession, setFailedRememberedSession] =
        useState<PersistedMatrixSession | null>(null);
    const [bootError, setBootError] = useState<string | null>(null);
    const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
    const designPreview = useSyncExternalStore(
        subscribeToPreviewFlag,
        readPreviewFlag,
        () => false,
    );

    useEffect(() => {
        const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
        const displayMode = window.matchMedia("(display-mode: standalone)");
        const browserViewport = viewport?.content ?? "width=device-width, initial-scale=1";
        const isStandalone = () =>
            displayMode.matches ||
            Boolean((navigator as Navigator & { standalone?: boolean }).standalone);

        const applyDisplayMode = () => {
            const standalone = isStandalone();

            document.documentElement.dataset.displayMode = standalone ? "standalone" : "browser";

            if (viewport) {
                viewport.content = standalone
                    ? "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
                    : browserViewport;
            }
        };

        const preventZoomShortcut = (event: KeyboardEvent) => {
            if (
                isStandalone() &&
                (event.ctrlKey || event.metaKey) &&
                ["+", "-", "=", "0"].includes(event.key)
            ) {
                event.preventDefault();
            }
        };

        const preventZoomWheel = (event: WheelEvent) => {
            if (isStandalone() && event.ctrlKey) {
                event.preventDefault();
            }
        };

        applyDisplayMode();
        displayMode.addEventListener("change", applyDisplayMode);
        window.addEventListener("keydown", preventZoomShortcut);
        window.addEventListener("wheel", preventZoomWheel, { passive: false });

        return () => {
            displayMode.removeEventListener("change", applyDisplayMode);
            window.removeEventListener("keydown", preventZoomShortcut);
            window.removeEventListener("wheel", preventZoomWheel);

            if (viewport) {
                viewport.content = browserViewport;
            }

            delete document.documentElement.dataset.displayMode;
        };
    }, []);

    const connect = useCallback(async (session: PersistedMatrixSession) => {
        setBootState("booting");
        setBootError(null);
        setNotice(null);

        if (session.storageMode === "remembered") {
            try {
                await saveSession(session);
            } catch (error) {
                setFailedRememberedSession(session);
                setBootError(
                    (error instanceof Error ? error.message : "Private storage failed.") +
                        " Nothing was saved in plaintext. Continue privately or erase local data.",
                );
                setBootState("error");

                return;
            }
        }

        setFailedRememberedSession(null);
        const { MatrixAlreadyOpenError, MatrixService: MatrixServiceImplementation } =
            await import("@/lib/matrix/client");
        const nextService = new MatrixServiceImplementation(session);

        try {
            await nextService.start();
            setService(nextService);
            setBootState("connected");
        } catch (error) {
            nextService.stop();

            if (error instanceof MatrixAlreadyOpenError) {
                setBootState("duplicate");
            } else {
                setBootError(humanizeMatrixError(error));
                setBootState("error");
            }
        }
    }, []);

    useEffect(() => {
        if (readPreviewFlag()) {
            return;
        }

        const storedTheme = localStorage.getItem("sub-etha-theme");

        if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
            document.documentElement.dataset.theme = storedTheme;
        } else {
            document.documentElement.dataset.theme = "dark";
        }

        let registration: ServiceWorkerRegistration | null = null;

        const watchInstalling = () => {
            const installing = registration?.installing;

            if (!installing) {
                return;
            }

            const changed = () => {
                if (installing.state === "installed" && navigator.serviceWorker.controller) {
                    setWaitingWorker(registration?.waiting ?? null);
                }
            };

            installing.addEventListener("statechange", changed);
        };

        void registerServiceWorker()
            .then((nextRegistration) => {
                registration = nextRegistration;

                if (registration?.waiting && navigator.serviceWorker.controller) {
                    setWaitingWorker(registration.waiting);
                }

                registration?.addEventListener("updatefound", watchInstalling);
            })
            .catch(() => undefined);
        let cancelled = false;

        void (async () => {
            try {
                const pendingCleanup = await retryPendingCleanup();

                if (pendingCleanup && !pendingCleanup.complete) {
                    throw new Error(
                        "Local cleanup is still blocked. Close other Sub-Etha tabs, retry, or erase all local data.",
                    );
                }

                const redirectSession = await completeRedirectLogin();
                const session = redirectSession ?? (await readSession());

                if (cancelled) {
                    return;
                }

                if (session) {
                    try {
                        session.baseUrl = assertAllowedHomeserverUrl(session.baseUrl);
                    } catch (error) {
                        if (error instanceof InsecureHomeserverError) {
                            await clearSession();
                        }

                        throw error;
                    }

                    await connect(session);
                } else {
                    setBootState("login");
                }
            } catch (error) {
                if (!cancelled) {
                    setBootError(humanizeMatrixError(error));
                    setBootState("error");
                }
            }
        })();

        return () => {
            cancelled = true;
            registration?.removeEventListener("updatefound", watchInstalling);
        };
    }, [connect]);

    useEffect(() => () => service?.stop(), [service]);

    const logout = async () => {
        if (!service) {
            return;
        }

        let cleanup: CleanupOutcome;

        try {
            await service.prepareLogout();
            await disablePush(service).catch(() => undefined);
            cleanup = await service.logout();
        } catch (error) {
            setBootError(
                `Local cleanup could not be prepared safely: ${humanizeMatrixError(error)}`,
            );
            setBootState("error");

            return;
        }

        if (!cleanup.localCredentialsRemoved) {
            setBootError(
                "Local credentials could not be removed. Close other Sub-Etha tabs and retry, or erase all data.",
            );
            setBootState("error");

            return;
        }

        setService(null);
        setNotice(
            cleanup.complete && cleanup.remoteRevocationConfirmed
                ? "Signed out and cleared local account data."
                : (cleanup.warning ??
                      "Signed out locally. Some cache deletion or remote revocation could not be confirmed."),
        );
        setBootState("login");
        window.history.replaceState({}, "", window.location.pathname);
    };

    const eraseAll = async () => {
        if (
            window.prompt(
                "Type ERASE to remove every Sub-Etha account, key, draft, cache, push subscription, and service worker from this browser.",
            ) !== "ERASE"
        ) {
            return;
        }

        setBootState("booting");
        setBootError(null);
        const activeService = service;
        const cleanup = await eraseAllSubEthaData(async () => {
            const pushCleared = await clearPushForReset(activeService ?? undefined);

            if (!activeService) {
                return pushCleared;
            }

            const accountCleanup = await activeService.logout();

            return pushCleared && accountCleanup.remoteRevocationConfirmed;
        });

        setService(null);
        setFailedRememberedSession(null);
        setNotice(
            cleanup.complete
                ? "All managed Sub-Etha data was erased from this browser."
                : (cleanup.warning ??
                      "Erasure was partial. Close other tabs and use the browser's Clear site data control."),
        );
        setBootState("login");
        window.history.replaceState({}, "", window.location.pathname);
    };

    const continuePrivately = async () => {
        if (!failedRememberedSession) {
            return;
        }

        await connect({
            ...failedRememberedSession,
            storageMode: "private",
        });
    };

    const takeOver = async () => {
        setBootState("booting");
        localStorage.setItem("sub-etha-account-takeover", `${Date.now()}-${Math.random()}`);
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        const session = await readSession();

        if (session) {
            await connect(session);
        } else {
            setBootState("login");
        }
    };

    const applyUpdate = () => {
        if (!waitingWorker) {
            return;
        }

        navigator.serviceWorker.addEventListener(
            "controllerchange",
            () => window.location.reload(),
            { once: true },
        );
        waitingWorker.postMessage({ type: "SKIP_WAITING" });
    };

    if (designPreview) {
        return <DesignPreview />;
    }

    if (bootState === "login") {
        return <LoginScreen onAuthenticated={connect} onEraseAll={eraseAll} notice={notice} />;
    }

    if (bootState === "connected" && service) {
        return (
            <>
                <ChatShell service={service} onLogout={logout} onEraseAll={eraseAll} />
                {waitingWorker ? (
                    <div className={classes("update-toast")} role="status">
                        <RefreshCw />
                        <span>
                            <strong>A revised field guide is ready.</strong>
                            <small>
                                Update when you have finished composing anything important.
                            </small>
                        </span>
                        <button type="button" onClick={applyUpdate}>
                            Update now
                        </button>
                    </div>
                ) : null}
            </>
        );
    }

    if (bootState === "duplicate") {
        return (
            <main className={classes("boot-screen")}>
                <BrandMark />
                <div className={classes("boot-card")}>
                    <RadioTower aria-hidden="true" />
                    <p className={classes("eyebrow")}>ONE RECEIVER AT A TIME</p>
                    <h1>Sub-Etha is already open elsewhere.</h1>
                    <p>
                        To protect your encryption store, only one tab may tune this account at
                        once. You may release the other receiver and continue here.
                    </p>
                    <div className={classes("button-row")}>
                        <button
                            className={classes("primary-button")}
                            type="button"
                            onClick={() => void takeOver()}
                        >
                            <RadioTower />
                            Use this tab
                        </button>
                        <button
                            className={classes("secondary-button")}
                            type="button"
                            onClick={() => window.location.reload()}
                        >
                            <RefreshCw />
                            Try again
                        </button>
                    </div>
                </div>
            </main>
        );
    }

    if (bootState === "error") {
        return (
            <main className={classes("boot-screen")}>
                <BrandMark />
                <div className={classes("boot-card boot-card--error")}>
                    <ShieldAlert aria-hidden="true" />
                    <p className={classes("eyebrow")}>SIGNAL INTERRUPTED</p>
                    <h1>The receiver declined to become haunted.</h1>
                    <p>{bootError}</p>
                    {failedRememberedSession ? (
                        <button
                            className={classes("primary-button")}
                            type="button"
                            onClick={() => void continuePrivately()}
                        >
                            Continue privately
                        </button>
                    ) : null}
                    <div className={classes("button-row")}>
                        <button
                            className={classes("primary-button")}
                            type="button"
                            onClick={() => window.location.reload()}
                        >
                            <RefreshCw />
                            Try again
                        </button>
                        <button
                            className={classes("secondary-button")}
                            type="button"
                            onClick={() => setBootState("login")}
                        >
                            Return to sign in
                        </button>
                        <button
                            className={classes("secondary-button")}
                            type="button"
                            onClick={() => void eraseAll()}
                        >
                            Erase all Sub-Etha data
                        </button>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className={classes("boot-screen")} aria-busy="true">
            <BrandMark />
            <div className={classes("tuning-indicator")} aria-live="polite">
                <span>
                    <LoaderCircle className={classes("spin")} />
                </span>
                <p>
                    Aligning local encryption, room indexes and a modest number of invisible
                    antennas…
                </p>
            </div>
        </main>
    );
}
