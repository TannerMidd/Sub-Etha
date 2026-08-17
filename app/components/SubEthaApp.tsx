"use client";

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { RadioTower, RefreshCw, ShieldAlert } from "lucide-react";
import {
    completeRedirectLogin,
    hasRedirectLoginParameters,
    humanizeMatrixError,
    OAuthPostGrantRevocationUnconfirmedError,
} from "@/lib/matrix/auth";
import type { MatrixService } from "@/lib/matrix/client";
import { clearLegacyPersistedDrafts, clearMemoryDrafts } from "@/lib/matrix/drafts";
import {
    clearAbandonedMatrixPusherWarning,
    forgetLocalPushState,
    hasBrowserPushArtifacts,
    hasLocalPushStateForCleanup,
    hasPendingLocalPushCleanup,
    readAbandonedMatrixPusherWarning,
    registerServiceWorker,
} from "@/lib/matrix/notifications";
import {
    clearRemoteSessionWarning,
    persistRemoteLogoutWarning,
    persistRemotePendingWarning,
    persistRemoteRefreshWarning,
    readRemoteSessionWarning,
    REMOTE_LOGOUT_WARNING,
    REMOTE_PENDING_WARNING,
} from "@/lib/matrix/remote-session-warning";
import {
    cleanupSessionDatabases,
    completeLocalSessionCleanup,
    createLockedSession,
    forgetLocalSession,
    generateRecoveryKey,
    inspectSession,
    migrateLegacySession,
    unlockSession,
    type LegacySessionCandidate,
    type LockedSessionDescriptor,
    type SessionCleanupDescriptor,
    type SessionLease,
    type VaultInspection,
} from "@/lib/matrix/session-store";
import type { PersistedMatrixSession } from "@/lib/matrix/types";
import {
    beginWebAuthnPrfEnrollment,
    completeWebAuthnPrfEnrollment,
    webAuthnPrfSupportHint,
    type WebAuthnPrfEnrollment,
} from "@/lib/security/webauthn-prf";
import { BrandMark } from "./BrandMark";
import { ChatShell, parseRoomHash } from "./ChatShell";
import { LoginScreen } from "./LoginScreen";
import { SessionVaultScreen } from "./SessionVaultScreen";
import styles from "../styles/App.module.scss";
import { classes, configureStyles } from "../styles/appStyles";

configureStyles(styles);

interface SetupBase {
    kind: "setup";
    recoveryKey: string;
    deviceAvailable: boolean;
    deviceEnrollment: WebAuthnPrfEnrollment | null;
    busy: boolean;
    error: string | null;
}

type SetupState =
    | (SetupBase & { mode: "enrollment"; session: PersistedMatrixSession })
    | (SetupBase & { mode: "migration"; candidate: LegacySessionCandidate });

type AppState =
    | { kind: "booting" }
    | { kind: "login" }
    | SetupState
    | { kind: "locked"; descriptor: LockedSessionDescriptor; busy: boolean; error: string | null }
    | { kind: "cleanup"; descriptor: SessionCleanupDescriptor; busy: boolean; error: string | null }
    | { kind: "push-cleanup"; busy: boolean; error: string | null }
    | { kind: "corrupt"; message: string; busy: boolean; error: string | null }
    | { kind: "connected" }
    | { kind: "duplicate" }
    | {
          kind: "logout-warning";
          message: string;
          resume: "login" | "connected" | "route";
      }
    | { kind: "error"; message: string };

type SetupSource =
    | { mode: "enrollment"; session: PersistedMatrixSession }
    | { mode: "migration"; candidate: LegacySessionCandidate };

const DesignPreview = import.meta.env.DEV
    ? lazy(() => import("./DesignPreview").then((module) => ({ default: module.DesignPreview })))
    : null;

const readPreviewFlag = () =>
    import.meta.env.DEV &&
    ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname) &&
    new URLSearchParams(window.location.search).has("design-preview");

const ROUTE_SCRUB_GUARD = "sub-etha-route-scrub-v1";
const scrubRoute = () => window.history.replaceState({}, "", window.location.pathname);

const combineSecurityWarnings = (...additional: Array<string | null | undefined>) => {
    const message = [
        ...new Set([...additional, readRemoteSessionWarning(), readAbandonedMatrixPusherWarning()]),
    ]
        .filter((warning): warning is string => Boolean(warning))
        .join(" ");

    return message || null;
};

const cleanupDescriptorMatches = (
    left: SessionCleanupDescriptor,
    right: SessionCleanupDescriptor,
) =>
    left.recordId === right.recordId &&
    left.revision === right.revision &&
    left.scope === right.scope &&
    left.cryptoDatabasePrefix === right.cryptoDatabasePrefix &&
    left.legacySyncDatabase === right.legacySyncDatabase;

export function SubEthaApp() {
    const [appState, setAppState] = useState<AppState>({ kind: "booting" });
    const [service, setService] = useState<MatrixService | null>(null);
    const [designPreview, setDesignPreview] = useState(false);
    const logoutInProgress = useRef(false);
    const operationGeneration = useRef(0);
    const serviceRef = useRef<MatrixService | null>(null);
    const pendingServiceRef = useRef<MatrixService | null>(null);
    const pendingLeaseRef = useRef<SessionLease | null>(null);
    const pendingUnsealedSessionRef = useRef<PersistedMatrixSession | null>(null);
    const authenticationCallbackPendingRef = useRef(false);
    const authenticationInFlightRef = useRef(false);
    const vaultOperationAbortRef = useRef<AbortController | null>(null);
    const appStateRef = useRef<AppState>(appState);
    const routeScrubActive = useRef(false);
    const routeInspectionRef = useRef<
        (provided?: VaultInspection, operation?: number) => Promise<void>
    >(async () => undefined);

    appStateRef.current = appState;

    const advanceOperation = useCallback(() => {
        vaultOperationAbortRef.current?.abort();
        vaultOperationAbortRef.current = null;

        return ++operationGeneration.current;
    }, []);

    const replaceService = useCallback((next: MatrixService | null, expected?: MatrixService) => {
        const current = serviceRef.current;

        if (expected && current !== expected) {
            return;
        }

        if (current && current !== next) {
            current.stop();
        }

        serviceRef.current = next;
        setService(next);
    }, []);

    const beginRouteScrub = useCallback(() => {
        routeScrubActive.current = true;

        try {
            sessionStorage.setItem(ROUTE_SCRUB_GUARD, "1");
        } catch {
            // The in-memory guard still protects this document when session storage is blocked.
        }

        scrubRoute();
    }, []);

    const endRouteScrub = useCallback(() => {
        routeScrubActive.current = false;

        try {
            sessionStorage.removeItem(ROUTE_SCRUB_GUARD);
        } catch {
            // A blocked session store cannot weaken the in-memory guard.
        }
    }, []);

    useEffect(() => {
        authenticationCallbackPendingRef.current = hasRedirectLoginParameters(
            window.location.search,
            window.location.hash,
        );

        try {
            routeScrubActive.current = sessionStorage.getItem(ROUTE_SCRUB_GUARD) === "1";
        } catch {
            // Preserve the current in-memory value when session storage is blocked.
        }

        const scrubSensitiveHistoryEntry = () => {
            const state = (window.history.state ?? {}) as { subEthaView?: unknown };

            if (
                routeScrubActive.current &&
                !authenticationCallbackPendingRef.current &&
                (window.location.hash.length > 0 || state.subEthaView !== undefined)
            ) {
                scrubRoute();
            }
        };

        scrubSensitiveHistoryEntry();
        window.addEventListener("popstate", scrubSensitiveHistoryEntry);
        window.addEventListener("hashchange", scrubSensitiveHistoryEntry);

        return () => {
            window.removeEventListener("popstate", scrubSensitiveHistoryEntry);
            window.removeEventListener("hashchange", scrubSensitiveHistoryEntry);
        };
    }, []);

    useEffect(() => {
        if (!import.meta.env.DEV) {
            return;
        }

        const refresh = () => setDesignPreview(readPreviewFlag());

        refresh();
        window.addEventListener("popstate", refresh);
        window.addEventListener("hashchange", refresh);

        return () => {
            window.removeEventListener("popstate", refresh);
            window.removeEventListener("hashchange", refresh);
        };
    }, []);

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
                    ? "width=device-width, initial-scale=1, viewport-fit=cover"
                    : browserViewport;
            }
        };

        applyDisplayMode();
        displayMode.addEventListener("change", applyDisplayMode);

        return () => {
            displayMode.removeEventListener("change", applyDisplayMode);

            if (viewport) {
                viewport.content = browserViewport;
            }

            delete document.documentElement.dataset.displayMode;
        };
    }, []);

    const clearPendingUnsealedSession = useCallback((session: PersistedMatrixSession) => {
        if (pendingUnsealedSessionRef.current === session) {
            pendingUnsealedSessionRef.current = null;
        }
    }, []);

    const revokeDiscardedUnsealedSession = useCallback(
        async (session: PersistedMatrixSession) => {
            try {
                const { revokePendingMatrixSession } = await import("@/lib/matrix/client");
                const result = await revokePendingMatrixSession(session);

                if (result.confirmed) {
                    clearPendingUnsealedSession(session);
                } else {
                    persistRemotePendingWarning();
                }
            } catch {
                persistRemotePendingWarning();
            }
        },
        [clearPendingUnsealedSession],
    );

    const prepareSetup = useCallback(
        async (source: SetupSource, providedOperation?: number) => {
            const operation = providedOperation ?? advanceOperation();

            if (source.mode === "enrollment") {
                // Track the issued homeserver session before the first asynchronous setup step.
                // pagehide can then preserve an honest remote-revocation warning even before the
                // enrollment screen has rendered.
                pendingUnsealedSessionRef.current = source.session;
            }

            const recoveryKey = generateRecoveryKey();
            const support = await webAuthnPrfSupportHint().catch(() => "unknown" as const);

            if (operation !== operationGeneration.current) {
                if (source.mode === "enrollment") {
                    await revokeDiscardedUnsealedSession(source.session);
                }

                return;
            }

            const base: SetupBase = {
                kind: "setup",
                recoveryKey,
                deviceAvailable: support !== "unavailable",
                deviceEnrollment: null,
                busy: false,
                error: null,
            };

            setAppState(
                source.mode === "enrollment"
                    ? { ...base, mode: source.mode, session: source.session }
                    : { ...base, mode: source.mode, candidate: source.candidate },
            );
        },
        [advanceOperation, revokeDiscardedUnsealedSession],
    );

    const runCleanup = useCallback(
        async (
            descriptor: SessionCleanupDescriptor,
            preparedPushCleanup?: ReturnType<typeof forgetLocalPushState>,
            providedOperation?: number,
            completionWarning?: string,
        ) => {
            const operation = providedOperation ?? advanceOperation();

            if (operation !== operationGeneration.current) {
                await preparedPushCleanup?.catch(() => undefined);

                return;
            }

            replaceService(null);
            clearMemoryDrafts();
            beginRouteScrub();
            setAppState({ kind: "cleanup", descriptor, busy: true, error: null });

            try {
                // A retry can outlive its tombstone in another tab. Validate the exact Matrix
                // cleanup marker before touching push state so an obsolete retry cannot clear a
                // newly enrolled account's subscription.
                await cleanupSessionDatabases(descriptor);

                if (operation !== operationGeneration.current) {
                    await preparedPushCleanup?.catch(() => undefined);

                    return;
                }

                const pushResult = await (preparedPushCleanup ??
                    forgetLocalPushState(undefined, {
                        abandonMatrixPusherAfterGatewayCleanup: true,
                    }));

                if (operation !== operationGeneration.current) {
                    return;
                }

                if (!pushResult.complete) {
                    throw new Error(
                        pushResult.error ??
                            "Notification cleanup is queued and needs another retry.",
                    );
                }

                await completeLocalSessionCleanup(descriptor);

                if (operation !== operationGeneration.current) {
                    return;
                }

                const remoteWarning = combineSecurityWarnings(completionWarning);

                setAppState(
                    remoteWarning
                        ? {
                              kind: "logout-warning",
                              message: remoteWarning,
                              resume: "login",
                          }
                        : { kind: "login" },
                );
            } catch (error) {
                // Active-session logout may already be cleaning push state in parallel. Always
                // settle that work before surfacing a retry so no delayed mutation escapes this
                // operation.
                await preparedPushCleanup?.catch(() => undefined);

                if (operation !== operationGeneration.current) {
                    return;
                }

                try {
                    const inspection = await inspectSession();

                    if (
                        operation === operationGeneration.current &&
                        (inspection.kind !== "cleanup" ||
                            !cleanupDescriptorMatches(descriptor, inspection))
                    ) {
                        await routeInspectionRef.current(inspection, operation);

                        return;
                    }
                } catch {
                    // Preserve the exact cleanup error if re-inspection also fails.
                }

                setAppState({
                    kind: "cleanup",
                    descriptor,
                    busy: false,
                    error: humanizeMatrixError(error),
                });
            }
        },
        [advanceOperation, beginRouteScrub, replaceService],
    );

    const routeInspection = useCallback(
        async (provided?: VaultInspection, providedOperation?: number) => {
            const operation = providedOperation ?? advanceOperation();

            if (operation !== operationGeneration.current) {
                return;
            }

            replaceService(null);
            const inspection = provided ?? (await inspectSession());

            if (operation !== operationGeneration.current) {
                return;
            }

            let deferredPusherCleanupError: string | null = null;

            if (
                inspection.kind !== "empty" &&
                inspection.kind !== "cleanup" &&
                hasPendingLocalPushCleanup()
            ) {
                const cleanup = await forgetLocalPushState();

                if (operation !== operationGeneration.current) {
                    return;
                }

                if (!cleanup.complete) {
                    deferredPusherCleanupError =
                        cleanup.error ??
                        "Unlock this account to finish removing its notification pusher.";
                }
            }

            if (inspection.kind !== "empty" && inspection.kind !== "cleanup") {
                const securityWarning = combineSecurityWarnings();

                if (securityWarning) {
                    setAppState({
                        kind: "logout-warning",
                        message: securityWarning,
                        resume: "route",
                    });

                    return;
                }
            }

            if (inspection.kind === "empty") {
                if (hasLocalPushStateForCleanup() || (await hasBrowserPushArtifacts())) {
                    if (operation !== operationGeneration.current) {
                        return;
                    }

                    setAppState({ kind: "push-cleanup", busy: true, error: null });
                    const cleanup = await forgetLocalPushState();

                    if (operation !== operationGeneration.current) {
                        return;
                    }

                    if (!cleanup.complete) {
                        setAppState({
                            kind: "push-cleanup",
                            busy: false,
                            error:
                                cleanup.error ??
                                "Notification cleanup is queued and needs another retry.",
                        });

                        return;
                    }
                }

                const remoteWarning = combineSecurityWarnings();

                setAppState(
                    remoteWarning
                        ? { kind: "logout-warning", message: remoteWarning, resume: "login" }
                        : { kind: "login" },
                );

                return;
            }

            if (inspection.kind === "locked") {
                setAppState({
                    kind: "locked",
                    descriptor: inspection,
                    busy: false,
                    error: deferredPusherCleanupError,
                });

                return;
            }

            if (inspection.kind === "legacy") {
                await prepareSetup({ mode: "migration", candidate: inspection }, operation);

                return;
            }

            if (inspection.kind === "cleanup") {
                await runCleanup(inspection, undefined, operation);

                return;
            }

            setAppState({
                kind: "corrupt",
                message: inspection.message,
                busy: false,
                error: deferredPusherCleanupError,
            });
        },
        [advanceOperation, prepareSetup, replaceService, runCleanup],
    );

    useEffect(() => {
        routeInspectionRef.current = routeInspection;
    }, [routeInspection]);

    const connect = useCallback(
        async (lease: SessionLease, providedOperation?: number) => {
            const operation = providedOperation ?? advanceOperation();

            if (operation !== operationGeneration.current) {
                lease.dispose();

                return;
            }

            pendingLeaseRef.current?.dispose();
            pendingLeaseRef.current = lease;
            setAppState({ kind: "booting" });
            let invalidated = false;
            let nextService: MatrixService | null = null;
            let clientModule: typeof import("@/lib/matrix/client") | null = null;

            const handleInvalidated = (error: Error) => {
                if (logoutInProgress.current) {
                    return;
                }

                invalidated = true;

                if (
                    clientModule &&
                    error instanceof clientModule.MatrixSessionRevocationUnconfirmedError
                ) {
                    persistRemoteRefreshWarning();
                }

                clearMemoryDrafts();
                replaceService(null, nextService ?? undefined);
                const reroute = routeInspection();
                const rerouteOperation = operationGeneration.current;

                void reroute.catch((cause) => {
                    if (rerouteOperation === operationGeneration.current) {
                        setAppState({
                            kind: "error",
                            message: `${error.message} ${humanizeMatrixError(cause)}`,
                        });
                    }
                });
            };

            try {
                clientModule = await import("@/lib/matrix/client");

                if (operation !== operationGeneration.current) {
                    if (pendingLeaseRef.current === lease) {
                        pendingLeaseRef.current = null;
                    }

                    lease.dispose();

                    return;
                }

                nextService = new clientModule.MatrixService(lease, handleInvalidated);

                if (pendingLeaseRef.current === lease) {
                    pendingLeaseRef.current = null;
                }

                pendingServiceRef.current = nextService;
                await nextService.start();

                if (hasPendingLocalPushCleanup()) {
                    const cleanup = await forgetLocalPushState(nextService, {
                        abandonMatrixPusherAfterGatewayCleanup: true,
                    });

                    if (!cleanup.complete) {
                        throw new Error(
                            cleanup.error ??
                                "Notification cleanup must finish before this account can open.",
                        );
                    }
                }

                if (invalidated || operation !== operationGeneration.current) {
                    if (pendingServiceRef.current === nextService) {
                        pendingServiceRef.current = null;
                    }

                    nextService.stop();

                    return;
                }

                const routedRoomId = parseRoomHash();

                if (
                    routedRoomId &&
                    nextService.getSnapshot().rooms.some((room) => room.id === routedRoomId)
                ) {
                    nextService.selectRoom(routedRoomId);
                }

                endRouteScrub();

                if (pendingServiceRef.current === nextService) {
                    pendingServiceRef.current = null;
                }

                replaceService(nextService);
                const securityWarning = combineSecurityWarnings();

                setAppState(
                    securityWarning
                        ? {
                              kind: "logout-warning",
                              message: securityWarning,
                              resume: "connected",
                          }
                        : { kind: "connected" },
                );
            } catch (error) {
                if (pendingServiceRef.current === nextService) {
                    pendingServiceRef.current = null;
                }

                if (nextService) {
                    nextService.stop();
                } else {
                    if (pendingLeaseRef.current === lease) {
                        pendingLeaseRef.current = null;
                    }

                    lease.dispose();
                }

                clearMemoryDrafts();

                if (operation !== operationGeneration.current) {
                    return;
                }

                if (clientModule && error instanceof clientModule.MatrixAlreadyOpenError) {
                    setAppState({ kind: "duplicate" });
                } else {
                    setAppState({ kind: "error", message: humanizeMatrixError(error) });
                }
            }
        },
        [advanceOperation, endRouteScrub, replaceService, routeInspection],
    );

    useEffect(() => {
        if (readPreviewFlag()) {
            return;
        }

        clearLegacyPersistedDrafts();
        const storedTheme = localStorage.getItem("sub-etha-theme");

        if (storedTheme === "light" || storedTheme === "dark" || storedTheme === "system") {
            document.documentElement.dataset.theme = storedTheme;
        } else {
            document.documentElement.dataset.theme = "dark";
        }

        let cancelled = false;

        void registerServiceWorker().catch(() => undefined);

        void (async () => {
            const operation = advanceOperation();
            const callbackPending = hasRedirectLoginParameters(
                window.location.search,
                window.location.hash,
            );

            authenticationCallbackPendingRef.current = callbackPending;
            authenticationInFlightRef.current = callbackPending;
            const redirectLogin = completeRedirectLogin();

            authenticationCallbackPendingRef.current = false;

            if (hasRedirectLoginParameters(window.location.search, window.location.hash)) {
                try {
                    scrubRoute();
                } catch {
                    // completeRedirectLogin will preserve its original sanitization failure for
                    // the boot error path if the fallback history write is unavailable too.
                }
            }

            try {
                const redirectSession = await redirectLogin;

                if (cancelled || operation !== operationGeneration.current) {
                    if (redirectSession) {
                        try {
                            const { revokePendingMatrixSession } =
                                await import("@/lib/matrix/client");
                            const revocation = await revokePendingMatrixSession(redirectSession);

                            if (!revocation.confirmed) {
                                persistRemotePendingWarning();
                            }
                        } catch {
                            persistRemotePendingWarning();
                        }
                    }

                    return;
                }

                if (redirectSession) {
                    await prepareSetup({ mode: "enrollment", session: redirectSession }, operation);
                } else {
                    await routeInspection(undefined, operation);
                }
            } catch (error) {
                if (!cancelled && operation === operationGeneration.current) {
                    if (error instanceof OAuthPostGrantRevocationUnconfirmedError) {
                        persistRemotePendingWarning();
                        setAppState({
                            kind: "logout-warning",
                            message: REMOTE_PENDING_WARNING,
                            resume: "login",
                        });
                    } else {
                        setAppState({ kind: "error", message: humanizeMatrixError(error) });
                    }
                }
            } finally {
                authenticationInFlightRef.current = false;
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [advanceOperation, prepareSetup, routeInspection]);

    useEffect(() => {
        const scrubForPageHide = () => {
            advanceOperation();
            clearMemoryDrafts();

            const currentState = appStateRef.current;

            if (currentState.kind === "setup" && currentState.deviceEnrollment?.kind === "ready") {
                currentState.deviceEnrollment.prfOutput.fill(0);
            }

            if (
                authenticationInFlightRef.current ||
                pendingUnsealedSessionRef.current ||
                (currentState.kind === "setup" && currentState.mode === "enrollment")
            ) {
                // Page termination cannot reliably await revocation of a pre-vault login.
                persistRemotePendingWarning();
            }

            // Drop the app-owned reference synchronously. Any already-running revocation or vault
            // operation has its own bounded lifetime and must pass its generation/cancellation
            // fence before it can publish state again.
            pendingUnsealedSessionRef.current = null;
            authenticationInFlightRef.current = false;

            appStateRef.current = { kind: "booting" };
            setAppState({ kind: "booting" });

            const currentService = serviceRef.current;
            const pendingService = pendingServiceRef.current;
            const pendingLease = pendingLeaseRef.current;

            if (logoutInProgress.current) {
                // The document may terminate before remote logout reports success. Keep the
                // warning until a later continuation proves success and the user acknowledges it.
                persistRemoteLogoutWarning();
            }

            serviceRef.current = null;
            pendingServiceRef.current = null;
            pendingLeaseRef.current = null;
            setService(null);
            pendingLease?.dispose();
            const shutdown = currentService?.shutdownForPageHide();
            const pendingShutdown =
                pendingService && pendingService !== currentService
                    ? pendingService.shutdownForPageHide()
                    : undefined;

            if (shutdown?.refreshInFlight || pendingShutdown?.refreshInFlight) {
                // The document may freeze before an uncommitted refresh can report whether its
                // newly issued credentials were revoked. Preserve a conservative durable warning.
                persistRemoteRefreshWarning();
            }

            try {
                beginRouteScrub();
            } catch {
                // Runtime/key scrubbing above is the required page-lifecycle boundary. A
                // no-longer-active history entry may reject replaceState during pagehide.
            }
        };

        const handlePageShow = (event: PageTransitionEvent) => {
            if (event.persisted) {
                // Never resume a JavaScript heap that previously held an unlocked lease,
                // decrypted timeline, draft, or recovery material.
                window.location.reload();
            }
        };

        window.addEventListener("pagehide", scrubForPageHide);
        window.addEventListener("pageshow", handlePageShow);

        return () => {
            window.removeEventListener("pagehide", scrubForPageHide);
            window.removeEventListener("pageshow", handlePageShow);
            vaultOperationAbortRef.current?.abort();
            vaultOperationAbortRef.current = null;

            if (pendingUnsealedSessionRef.current) {
                persistRemotePendingWarning();
                pendingUnsealedSessionRef.current = null;
            }

            if (authenticationInFlightRef.current) {
                persistRemotePendingWarning();
                authenticationInFlightRef.current = false;
            }

            serviceRef.current?.shutdownForPageHide();
            pendingServiceRef.current?.shutdownForPageHide();
            pendingLeaseRef.current?.dispose();
            serviceRef.current = null;
            pendingServiceRef.current = null;
            pendingLeaseRef.current = null;
        };
    }, [advanceOperation, beginRouteScrub]);

    const finishSetup = async () => {
        if (appState.kind !== "setup" || appState.busy) {
            return;
        }

        const setup = appState;
        const operation = advanceOperation();
        const abortController = new AbortController();

        vaultOperationAbortRef.current = abortController;

        setAppState({ ...setup, busy: true, error: null });

        try {
            const deviceEnrollment =
                setup.deviceEnrollment?.kind === "ready" ? setup.deviceEnrollment : undefined;
            const lease =
                setup.mode === "enrollment"
                    ? await createLockedSession(
                          setup.session,
                          setup.recoveryKey,
                          deviceEnrollment,
                          { signal: abortController.signal },
                      )
                    : await migrateLegacySession(
                          setup.candidate,
                          setup.recoveryKey,
                          deviceEnrollment,
                          { signal: abortController.signal },
                      );

            if (setup.mode === "enrollment") {
                // The session is now sealed in the vault and owned by the returned lease.
                clearPendingUnsealedSession(setup.session);
            }

            if (operation !== operationGeneration.current) {
                lease.dispose();

                return;
            }

            await connect(lease, operation);
        } catch (error) {
            if (operation !== operationGeneration.current) {
                return;
            }

            if (
                setup.mode === "enrollment" &&
                error instanceof Error &&
                "code" in error &&
                error.code === "conflict"
            ) {
                const { revokePendingMatrixSession } = await import("@/lib/matrix/client");
                const revocation = await revokePendingMatrixSession(setup.session);

                if (operation !== operationGeneration.current) {
                    return;
                }

                if (!revocation.confirmed) {
                    setAppState({
                        ...setup,
                        busy: false,
                        error: "Secure setup could not claim the local vault, and the homeserver did not confirm revocation of the new Matrix session. Retry, or revoke this device from another trusted client before closing this tab.",
                    });

                    return;
                }

                clearPendingUnsealedSession(setup.session);

                const inspection = await inspectSession();

                if (operation !== operationGeneration.current) {
                    return;
                }

                if (inspection.kind !== "empty") {
                    await routeInspection(inspection, operation);

                    return;
                }

                setAppState({ kind: "login" });

                return;
            }

            if (setup.mode === "migration") {
                try {
                    const inspection = await inspectSession();

                    if (
                        operation === operationGeneration.current &&
                        (inspection.kind === "locked" || inspection.kind === "cleanup")
                    ) {
                        await routeInspection(inspection, operation);

                        return;
                    }
                } catch {
                    // Preserve the original migration error below when inspection also fails.
                }
            }

            if (setup.deviceEnrollment?.kind === "ready") {
                setup.deviceEnrollment.prfOutput.fill(0);
            }

            setAppState((current) =>
                current.kind === "setup"
                    ? {
                          ...current,
                          busy: false,
                          error: humanizeMatrixError(error),
                          deviceEnrollment:
                              current.deviceEnrollment?.kind === "ready"
                                  ? null
                                  : current.deviceEnrollment,
                      }
                    : current,
            );
        } finally {
            if (vaultOperationAbortRef.current === abortController) {
                vaultOperationAbortRef.current = null;
            }
        }
    };

    const beginDeviceEnrollment = async () => {
        if (appState.kind !== "setup" || appState.busy) {
            return;
        }

        const operation = advanceOperation();

        setAppState({ ...appState, busy: true, error: null });

        try {
            const enrollment = await beginWebAuthnPrfEnrollment();

            if (operation !== operationGeneration.current) {
                if (enrollment.kind === "ready") {
                    enrollment.prfOutput.fill(0);
                }

                return;
            }

            setAppState((current) =>
                current.kind === "setup"
                    ? { ...current, busy: false, deviceEnrollment: enrollment }
                    : current,
            );
        } catch (error) {
            if (operation !== operationGeneration.current) {
                return;
            }

            setAppState((current) =>
                current.kind === "setup"
                    ? { ...current, busy: false, error: humanizeMatrixError(error) }
                    : current,
            );
        }
    };

    const completeDeviceEnrollment = async () => {
        if (
            appState.kind !== "setup" ||
            appState.busy ||
            appState.deviceEnrollment?.kind !== "pending"
        ) {
            return;
        }

        const pending = appState.deviceEnrollment;
        const operation = advanceOperation();

        setAppState({ ...appState, busy: true, error: null });

        try {
            const enrollment = await completeWebAuthnPrfEnrollment(pending);

            if (operation !== operationGeneration.current) {
                if (enrollment.kind === "ready") {
                    enrollment.prfOutput.fill(0);
                }

                return;
            }

            setAppState((current) =>
                current.kind === "setup"
                    ? { ...current, busy: false, deviceEnrollment: enrollment }
                    : current,
            );
        } catch (error) {
            if (operation !== operationGeneration.current) {
                return;
            }

            setAppState((current) =>
                current.kind === "setup"
                    ? { ...current, busy: false, error: humanizeMatrixError(error) }
                    : current,
            );
        }
    };

    const unlock = async (method: "device" | "recovery", recoveryKey?: string) => {
        if (appState.kind !== "locked" || appState.busy) {
            return;
        }

        const locked = appState;
        const operation = advanceOperation();
        const slot = locked.descriptor.unlockSlots.find((candidate) =>
            method === "device"
                ? candidate.kind === "webauthn-prf"
                : candidate.kind === "recovery-key",
        );

        if (!slot) {
            setAppState({ ...locked, error: "That unlock method is not enrolled." });

            return;
        }

        const abortController = new AbortController();

        vaultOperationAbortRef.current = abortController;

        setAppState({ ...locked, busy: true, error: null });

        try {
            const lease = await unlockSession(
                locked.descriptor,
                method === "device"
                    ? { kind: "webauthn-prf", slotId: slot.slotId }
                    : { kind: "recovery-key", recoveryKey: recoveryKey ?? "", slotId: slot.slotId },
                { signal: abortController.signal },
            );

            if (operation !== operationGeneration.current) {
                lease.dispose();

                return;
            }

            await connect(lease, operation);
        } catch (error) {
            if (operation !== operationGeneration.current) {
                return;
            }

            setAppState((current) =>
                current.kind === "locked"
                    ? { ...current, busy: false, error: humanizeMatrixError(error) }
                    : current,
            );
        } finally {
            if (vaultOperationAbortRef.current === abortController) {
                vaultOperationAbortRef.current = null;
            }
        }
    };

    const forgetBrowser = async () => {
        if (
            !["locked", "setup", "corrupt"].includes(appState.kind) ||
            ("busy" in appState && appState.busy)
        ) {
            return;
        }

        const operation = advanceOperation();

        beginRouteScrub();
        replaceService(null);

        if (
            appState.kind === "locked" ||
            appState.kind === "setup" ||
            appState.kind === "corrupt"
        ) {
            setAppState({ ...appState, busy: true, error: null });
        }

        try {
            const cleanup = await forgetLocalSession();

            if (operation !== operationGeneration.current) {
                return;
            }

            if (appState.kind === "setup" && appState.deviceEnrollment?.kind === "ready") {
                appState.deviceEnrollment.prfOutput.fill(0);
            }

            await runCleanup(cleanup, undefined, operation);
        } catch (error) {
            if (operation !== operationGeneration.current) {
                return;
            }

            setAppState((current) =>
                current.kind === "locked" || current.kind === "setup" || current.kind === "corrupt"
                    ? { ...current, busy: false, error: humanizeMatrixError(error) }
                    : current,
            );
        }
    };

    const cancelEnrollment = async () => {
        if (appState.kind !== "setup" || appState.mode !== "enrollment" || appState.busy) {
            return;
        }

        const setup = appState;
        const operation = advanceOperation();

        beginRouteScrub();
        setAppState({ ...setup, busy: true, error: null });

        try {
            const { revokePendingMatrixSession } = await import("@/lib/matrix/client");
            const result = await revokePendingMatrixSession(setup.session);

            if (operation !== operationGeneration.current) {
                return;
            }

            if (!result.confirmed) {
                setAppState({
                    ...setup,
                    busy: false,
                    error: "The homeserver did not confirm revocation. Retry cancellation, or revoke this device from another trusted Matrix client before closing this tab.",
                });

                return;
            }

            clearPendingUnsealedSession(setup.session);

            if (setup.deviceEnrollment?.kind === "ready") {
                setup.deviceEnrollment.prfOutput.fill(0);
            }

            clearMemoryDrafts();
            setAppState({ kind: "login" });
        } catch (error) {
            if (operation === operationGeneration.current) {
                setAppState({
                    ...setup,
                    busy: false,
                    error:
                        "The pending Matrix session could not be revoked. Retry cancellation, or revoke this device from another trusted Matrix client. " +
                        humanizeMatrixError(error),
                });
            }
        }
    };

    const logout = async () => {
        if (!service || logoutInProgress.current) {
            return;
        }

        const activeService = service;
        let logoutError: unknown = null;
        let remoteSessionEnded = false;
        const operation = advanceOperation();

        logoutInProgress.current = true;
        clearMemoryDrafts();
        setAppState({ kind: "booting" });
        beginRouteScrub();
        const pushCleanup = forgetLocalPushState(activeService, {
            abandonMatrixPusherAfterGatewayCleanup: true,
        });

        try {
            remoteSessionEnded = (await activeService.logout()).remoteSessionEnded;
        } catch (error) {
            logoutError = error;
        }

        replaceService(null, activeService);
        clearMemoryDrafts();

        try {
            const inspection = await inspectSession();
            const pushResult = await pushCleanup;

            if (operation === operationGeneration.current) {
                const remoteWarning = combineSecurityWarnings(
                    remoteSessionEnded ? null : REMOTE_LOGOUT_WARNING,
                );

                if (!remoteSessionEnded) {
                    persistRemoteLogoutWarning();
                }

                if (inspection.kind === "cleanup") {
                    await runCleanup(
                        inspection,
                        Promise.resolve(pushResult),
                        operation,
                        remoteWarning ?? undefined,
                    );
                } else if (logoutError && inspection.kind !== "empty") {
                    setAppState({
                        kind: "error",
                        message:
                            "Sign-out may have ended the remote Matrix session, but local cleanup did not finish. The local vault remains closed. Return to it and use Forget this browser to remove the remaining local data. " +
                            humanizeMatrixError(logoutError),
                    });
                } else if (!pushResult.complete) {
                    setAppState({
                        kind: "push-cleanup",
                        busy: false,
                        error:
                            pushResult.error ??
                            "Notification cleanup is queued and needs another retry.",
                    });
                } else if (remoteWarning && inspection.kind === "empty") {
                    setAppState({
                        kind: "logout-warning",
                        message: remoteWarning,
                        resume: "login",
                    });
                } else {
                    await routeInspection(inspection, operation);
                }
            }
        } catch (error) {
            if (operation === operationGeneration.current) {
                setAppState({ kind: "error", message: humanizeMatrixError(error) });
            }
        } finally {
            logoutInProgress.current = false;
        }
    };

    const takeOver = async () => {
        if (logoutInProgress.current) {
            return;
        }

        const operation = advanceOperation();

        beginRouteScrub();
        replaceService(null);
        setAppState({ kind: "booting" });
        localStorage.setItem("sub-etha-account-takeover", `${Date.now()}-${Math.random()}`);
        await new Promise((resolve) => window.setTimeout(resolve, 450));

        if (operation !== operationGeneration.current) {
            return;
        }

        clearMemoryDrafts();
        await routeInspection(undefined, operation);
    };

    if (designPreview && DesignPreview) {
        return (
            <Suspense fallback={null}>
                <DesignPreview />
            </Suspense>
        );
    }

    if (appState.kind === "login") {
        return (
            <LoginScreen
                onAuthenticated={(session) => prepareSetup({ mode: "enrollment", session })}
                onAuthenticationPendingChange={(pending) => {
                    authenticationInFlightRef.current = pending;
                }}
            />
        );
    }

    if (appState.kind === "setup") {
        const deviceEnrollment = !appState.deviceAvailable
            ? "unavailable"
            : (appState.deviceEnrollment?.kind ?? "available");

        return (
            <SessionVaultScreen
                mode={appState.mode}
                recoveryKey={appState.recoveryKey}
                deviceEnrollment={deviceEnrollment}
                busy={appState.busy}
                error={appState.error}
                onBeginDeviceEnrollment={() => void beginDeviceEnrollment()}
                onCompleteDeviceEnrollment={() => void completeDeviceEnrollment()}
                onContinue={() => void finishSetup()}
                {...(appState.mode === "migration"
                    ? { onForget: () => void forgetBrowser() }
                    : { onCancel: () => void cancelEnrollment() })}
            />
        );
    }

    if (appState.kind === "locked") {
        return (
            <SessionVaultScreen
                mode="locked"
                hasDeviceUnlock={appState.descriptor.unlockSlots.some(
                    (slot) => slot.kind === "webauthn-prf",
                )}
                busy={appState.busy}
                error={appState.error}
                onDeviceUnlock={() => void unlock("device")}
                onRecoveryUnlock={(recoveryKey) => void unlock("recovery", recoveryKey)}
                onForget={() => void forgetBrowser()}
            />
        );
    }

    if (appState.kind === "cleanup") {
        return (
            <SessionVaultScreen
                mode="cleanup"
                busy={appState.busy}
                error={appState.error}
                onRetry={() => void runCleanup(appState.descriptor)}
            />
        );
    }

    if (appState.kind === "push-cleanup") {
        return (
            <main className={classes("boot-screen")}>
                <BrandMark />
                <div className={classes("boot-card boot-card--error")}>
                    <ShieldAlert aria-hidden="true" />
                    <p className={classes("eyebrow")}>NOTIFICATION CLEANUP PENDING</p>
                    <h1>
                        The Matrix session is closed; browser notification cleanup needs a retry.
                    </h1>
                    <p>
                        The retry capability is retained locally. Sub-Etha will not enable a new
                        push subscription while this cleanup is pending.
                    </p>
                    {appState.error ? (
                        <div className={classes("error-note")} role="alert">
                            <strong>Cleanup did not finish.</strong>
                            <span>{appState.error}</span>
                        </div>
                    ) : null}
                    <button
                        className={classes("primary-button")}
                        type="button"
                        disabled={appState.busy}
                        onClick={() => void routeInspection()}
                    >
                        <RefreshCw />
                        Retry notification cleanup
                    </button>
                </div>
            </main>
        );
    }

    if (appState.kind === "corrupt") {
        return (
            <SessionVaultScreen
                mode="corrupt"
                busy={appState.busy}
                error={appState.error ?? appState.message}
                onForget={() => void forgetBrowser()}
            />
        );
    }

    if (appState.kind === "connected" && service) {
        return <ChatShell service={service} onLogout={logout} />;
    }

    if (appState.kind === "duplicate") {
        return (
            <main className={classes("boot-screen")}>
                <BrandMark />
                <div className={classes("boot-card")}>
                    <RadioTower aria-hidden="true" />
                    <p className={classes("eyebrow")}>ONE SECURE SESSION AT A TIME</p>
                    <h1>Sub-Etha is already open elsewhere.</h1>
                    <p>
                        Close the other tab, or release it and return here to unlock this browser
                        again.
                    </p>
                    <div className={classes("button-row")}>
                        <button
                            className={classes("primary-button")}
                            type="button"
                            onClick={() => void takeOver()}
                        >
                            <RadioTower />
                            Release other tab
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

    if (appState.kind === "logout-warning") {
        const acknowledgementLabel =
            appState.resume === "connected"
                ? "I understand; open the account"
                : appState.resume === "route"
                  ? "I understand; return to the vault"
                  : "I understand; return to sign in";

        return (
            <main className={classes("boot-screen")}>
                <BrandMark />
                <div className={classes("boot-card boot-card--error")}>
                    <ShieldAlert aria-hidden="true" />
                    <p className={classes("eyebrow")}>SECURITY ACTION REQUIRED</p>
                    <h1>Review what this browser could not confirm.</h1>
                    <p>{appState.message}</p>
                    <div className={classes("button-row")}>
                        <button
                            className={classes("primary-button")}
                            type="button"
                            onClick={() => {
                                clearRemoteSessionWarning();
                                clearAbandonedMatrixPusherWarning();

                                if (appState.resume === "connected") {
                                    setAppState({ kind: "connected" });

                                    return;
                                }

                                if (appState.resume === "login") {
                                    advanceOperation();
                                    setAppState({ kind: "login" });

                                    return;
                                }

                                const operation = advanceOperation();

                                setAppState({ kind: "booting" });
                                void routeInspection(undefined, operation).catch((error) => {
                                    if (operation === operationGeneration.current) {
                                        setAppState({
                                            kind: "error",
                                            message: humanizeMatrixError(error),
                                        });
                                    }
                                });
                            }}
                        >
                            {acknowledgementLabel}
                        </button>
                    </div>
                </div>
            </main>
        );
    }

    if (appState.kind === "error") {
        return (
            <main className={classes("boot-screen")}>
                <BrandMark />
                <div className={classes("boot-card boot-card--error")}>
                    <ShieldAlert aria-hidden="true" />
                    <p className={classes("eyebrow")}>SESSION INTERRUPTED</p>
                    <h1>Sub-Etha stopped before opening the account.</h1>
                    <p>{appState.message}</p>
                    <div className={classes("button-row")}>
                        <button
                            className={classes("primary-button")}
                            type="button"
                            onClick={() => void routeInspection()}
                        >
                            <RefreshCw />
                            Return to secure session
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
                <span aria-hidden="true">
                    <i />
                </span>
                <p>Preparing the local session vault and Matrix encryption…</p>
            </div>
        </main>
    );
}
