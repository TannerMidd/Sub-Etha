"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { LoaderCircle, RadioTower, RefreshCw, ShieldAlert } from "lucide-react";
import { completeRedirectLogin, humanizeMatrixError } from "@/lib/matrix/auth";
import type { MatrixService } from "@/lib/matrix/client";
import { disablePush, registerServiceWorker } from "@/lib/matrix/notifications";
import { clearSession, readSession, saveSession } from "@/lib/matrix/session-store";
import type { PersistedMatrixSession } from "@/lib/matrix/types";
import { assertAllowedHomeserverUrl, InsecureHomeserverError } from "@/lib/matrix/url-policy";
import { BrandMark } from "./BrandMark";
import { ChatShell } from "./ChatShell";
import { DesignPreview } from "./DesignPreview";
import { LoginScreen } from "./LoginScreen";

type BootState = "booting" | "login" | "connected" | "duplicate" | "error";
const subscribeToPreviewFlag = () => () => undefined;
const readPreviewFlag = () =>
    process.env.NODE_ENV !== "production" &&
    new URLSearchParams(window.location.search).has("design-preview");

export function SubEthaApp() {
    const [bootState, setBootState] = useState<BootState>("booting");
    const [service, setService] = useState<MatrixService | null>(null);
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
        await saveSession(session);
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
        if (
            process.env.NODE_ENV !== "production" &&
            new URLSearchParams(window.location.search).has("design-preview")
        ) {
            return;
        }

        const storedTheme = localStorage.getItem("sub-etha-theme");

        if (storedTheme === "light" || storedTheme === "dark") {
            document.documentElement.dataset.theme = storedTheme;
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

        await disablePush(service).catch(() => undefined);
        await service.logout();
        setService(null);
        setBootState("login");
        window.history.replaceState({}, "", window.location.pathname);
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
        return <LoginScreen onAuthenticated={connect} />;
    }

    if (bootState === "connected" && service) {
        return (
            <>
                <ChatShell service={service} onLogout={logout} />
                {waitingWorker ? (
                    <div className="update-toast" role="status">
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
            <main className="boot-screen">
                <BrandMark />
                <div className="boot-card">
                    <RadioTower aria-hidden="true" />
                    <p className="eyebrow">ONE RECEIVER AT A TIME</p>
                    <h1>Sub-Etha is already open elsewhere.</h1>
                    <p>
                        To protect your encryption store, only one tab may tune this account at
                        once. You may release the other receiver and continue here.
                    </p>
                    <div className="button-row">
                        <button
                            className="primary-button"
                            type="button"
                            onClick={() => void takeOver()}
                        >
                            <RadioTower />
                            Use this tab
                        </button>
                        <button
                            className="secondary-button"
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
            <main className="boot-screen">
                <BrandMark />
                <div className="boot-card boot-card--error">
                    <ShieldAlert aria-hidden="true" />
                    <p className="eyebrow">SIGNAL INTERRUPTED</p>
                    <h1>The receiver declined to become haunted.</h1>
                    <p>{bootError}</p>
                    <div className="button-row">
                        <button
                            className="primary-button"
                            type="button"
                            onClick={() => window.location.reload()}
                        >
                            <RefreshCw />
                            Try again
                        </button>
                        <button
                            className="secondary-button"
                            type="button"
                            onClick={() => setBootState("login")}
                        >
                            Return to sign in
                        </button>
                    </div>
                </div>
            </main>
        );
    }

    return (
        <main className="boot-screen" aria-busy="true">
            <BrandMark />
            <div className="tuning-indicator" aria-live="polite">
                <span>
                    <LoaderCircle className="spin" />
                </span>
                <p>
                    Aligning local encryption, room indexes and a modest number of invisible
                    antennas…
                </p>
            </div>
        </main>
    );
}
