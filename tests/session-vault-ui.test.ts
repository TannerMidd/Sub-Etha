import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    SessionVaultScreen,
    type SessionVaultScreenProps,
} from "../app/components/SessionVaultScreen";

const VAULT_SCREEN_SOURCE = new URL("../app/components/SessionVaultScreen.tsx", import.meta.url);
const COMPOSER_SOURCE = new URL("../app/components/Composer.tsx", import.meta.url);
const APP_SOURCE = new URL("../app/components/SubEthaApp.tsx", import.meta.url);
const LOGIN_SOURCE = new URL("../app/components/LoginScreen.tsx", import.meta.url);

type EnrollmentScreenProps = Extract<SessionVaultScreenProps, { recoveryKey: string }>;

function renderVault(props: SessionVaultScreenProps): string {
    return renderToStaticMarkup(createElement(SessionVaultScreen, props));
}

function enrollmentProps(overrides: Partial<EnrollmentScreenProps> = {}): EnrollmentScreenProps {
    return {
        mode: "enrollment",
        recoveryKey: "exact-recovery-key",
        deviceEnrollment: "available",
        busy: false,
        error: null,
        onBeginDeviceEnrollment: () => undefined,
        onCompleteDeviceEnrollment: () => undefined,
        onContinue: () => undefined,
        ...overrides,
    };
}

test("recovery enrollment requires an exact full-key confirmation before commit", async () => {
    const markup = renderVault(enrollmentProps());
    const source = await readFile(VAULT_SCREEN_SOURCE, "utf8");

    assert.match(markup, /<code>exact-recovery-key<\/code>/);
    assert.match(markup, /id="session-recovery-confirmation"/);
    assert.match(markup, new RegExp('<button[^>]*disabled=""[^>]*>.*Secure and continue', "s"));

    // React's server renderer cannot drive useState, so keep this contract
    // intentionally narrow: the value must be compared without normalization,
    // and that exact result must gate the only commit callback.
    assert.match(source, /const confirmed = confirmation === props\.recoveryKey;/);
    assert.match(source, /disabled=\{props\.busy \|\| !confirmed\}/);
    assert.match(source, /onClick=\{props\.onContinue\}/);
});

test("rendering enrollment never begins a WebAuthn ceremony", () => {
    let beginCalls = 0;
    let completeCalls = 0;

    const availableMarkup = renderVault(
        enrollmentProps({
            onBeginDeviceEnrollment: () => {
                beginCalls += 1;
            },
            onCompleteDeviceEnrollment: () => {
                completeCalls += 1;
            },
        }),
    );
    const pendingMarkup = renderVault(
        enrollmentProps({
            deviceEnrollment: "pending",
            onBeginDeviceEnrollment: () => {
                beginCalls += 1;
            },
            onCompleteDeviceEnrollment: () => {
                completeCalls += 1;
            },
        }),
    );

    assert.equal(beginCalls, 0);
    assert.equal(completeCalls, 0);
    assert.match(availableMarkup, />Add device unlock<\/button>/);
    assert.match(pendingMarkup, />Verify device unlock<\/button>/);
});

test("the locked screen retains recovery fallback with or without device unlock", () => {
    const baseProps = {
        mode: "locked" as const,
        busy: false,
        error: null,
        onDeviceUnlock: () => undefined,
        onRecoveryUnlock: () => undefined,
        onForget: () => undefined,
    };
    const withDevice = renderVault({ ...baseProps, hasDeviceUnlock: true });
    const recoveryOnly = renderVault({ ...baseProps, hasDeviceUnlock: false });

    assert.match(withDevice, />Unlock with this device<\/button>/);
    assert.match(withDevice, /id="session-recovery-key"/);
    assert.match(withDevice, />Unlock with recovery key<\/button>/);
    assert.doesNotMatch(recoveryOnly, />Unlock with this device<\/button>/);
    assert.match(recoveryOnly, /id="session-recovery-key"/);
    assert.match(recoveryOnly, />Unlock with recovery key<\/button>/);
});

test("pending cleanup blocks account access and exposes only an exact retry", () => {
    const markup = renderVault({
        mode: "cleanup",
        busy: false,
        error: "Another tab still owns the database.",
        onRetry: () => undefined,
    });

    assert.match(markup, /LOCAL CLEANUP INCOMPLETE/);
    assert.match(markup, /No account will open until the authorized local Matrix stores/);
    assert.match(markup, />Retry secure cleanup<\/button>/);
    assert.doesNotMatch(markup, /Unlock with recovery key/);
    assert.doesNotMatch(markup, /Return to sign in/);
});

test("every local-reset surface gives an explicit consequence warning", () => {
    const corruptMarkup = renderVault({
        mode: "corrupt",
        busy: false,
        error: "The local record failed validation.",
        onForget: () => undefined,
    });
    const lockedMarkup = renderVault({
        mode: "locked",
        hasDeviceUnlock: false,
        busy: false,
        error: null,
        onDeviceUnlock: () => undefined,
        onRecoveryUnlock: () => undefined,
        onForget: () => undefined,
    });
    const migrationMarkup = renderVault({
        ...enrollmentProps(),
        mode: "migration",
        onForget: () => undefined,
    });

    assert.match(corruptMarkup, />Forget local session<\/button>/);
    assert.match(corruptMarkup, /all local Sub-Etha Matrix vault, sync, and encryption data/);
    assert.match(corruptMarkup, /does not revoke Matrix sessions on the homeserver/);
    assert.match(corruptMarkup, /use another trusted client to revoke them/);
    assert.match(corruptMarkup, /The local record failed validation\./);

    assert.match(lockedMarkup, />Forget this browser<\/button>/);
    assert.match(
        lockedMarkup,
        /This permanently removes all local Sub-Etha Matrix session and encryption data\./,
    );
    assert.match(lockedMarkup, /It does not revoke the Matrix session/);
    assert.match(lockedMarkup, /use another trusted client to revoke it/);

    assert.match(migrationMarkup, />Forget this browser<\/button>/);
    assert.match(
        migrationMarkup,
        /permanently removes the existing local session and encryption store/,
    );
    assert.match(migrationMarkup, /without revoking the Matrix session on the homeserver/);
});

test("every local reset requires an arm activation before its confirm activation", async () => {
    let forgetCalls = 0;

    const onForget = () => {
        forgetCalls += 1;
    };

    const initialMarkup = [
        renderVault({
            mode: "corrupt",
            busy: false,
            error: null,
            onForget,
        }),
        renderVault({
            mode: "locked",
            hasDeviceUnlock: false,
            busy: false,
            error: null,
            onDeviceUnlock: () => undefined,
            onRecoveryUnlock: () => undefined,
            onForget,
        }),
        renderVault({
            ...enrollmentProps(),
            mode: "migration",
            onForget,
        }),
    ].join("\n");
    const source = await readFile(VAULT_SCREEN_SOURCE, "utf8");

    assert.equal(forgetCalls, 0);
    assert.doesNotMatch(initialMarkup, /Confirm local reset/);
    assert.equal(source.match(/onClick=\{confirmForget\}/g)?.length, 3);
    assert.doesNotMatch(source, /onClick=\{props\.onForget\}/);

    // There is no client-DOM component harness in this repository, so pin the
    // state transition itself: an unarmed activation can only arm this mode;
    // only a later activation in that same mode can invoke the reset callback.
    assert.match(source, /if \(forgetConfirmationMode === props\.mode\)/);
    assert.match(source, /if \(props\.mode !== "cleanup"\) \{\s*props\.onForget\?\.\(\);\s*\}/);
    assert.match(source, /setForgetConfirmationMode\(props\.mode\);/);
    assert.match(source, /const forgetArmed = forgetConfirmationMode === props\.mode;/);
    assert.equal(source.match(/forgetArmed \? "Confirm local reset"/g)?.length, 3);
});

test("Composer delegates drafts to memory and never accesses browser storage", async () => {
    const source = await readFile(COMPOSER_SOURCE, "utf8");

    assert.match(
        source,
        /import \{ readMemoryDraft, removeMemoryDraft, writeMemoryDraft \} from "@\/lib\/matrix\/drafts";/,
    );
    assert.match(source, /readMemoryDraft\(roomId\)/);
    assert.match(source, /writeMemoryDraft\(roomId, body\)/);
    assert.match(source, /removeMemoryDraft\(roomId\)/);
    assert.doesNotMatch(source, /localStorage/);
    assert.doesNotMatch(source, /sub-etha-draft/);
});

test("app cleanup ordering preserves local finality and partial migration recovery", async () => {
    const [source, loginSource] = await Promise.all([
        readFile(APP_SOURCE, "utf8"),
        readFile(LOGIN_SOURCE, "utf8"),
    ]);
    const cleanupStart = source.indexOf("const runCleanup");
    const cleanup = source.slice(
        cleanupStart,
        source.indexOf("const routeInspection = useCallback", cleanupStart),
    );
    const logout = source.slice(
        source.indexOf("const logout ="),
        source.indexOf("const takeOver ="),
    );
    const forget = source.slice(
        source.indexOf("const forgetBrowser ="),
        source.indexOf("const cancelEnrollment ="),
    );
    const invalidation = source.slice(
        source.indexOf("const handleInvalidated ="),
        source.indexOf("try {", source.indexOf("const handleInvalidated =")),
    );
    const initialRouteScrub = source.slice(
        source.indexOf("authenticationCallbackPendingRef.current = hasRedirectLoginParameters"),
        source.indexOf(
            "    }, []);",
            source.indexOf("authenticationCallbackPendingRef.current = hasRedirectLoginParameters"),
        ),
    );
    const callbackBoot = source.slice(
        source.indexOf("const callbackPending = hasRedirectLoginParameters"),
    );

    assert.ok(cleanup.indexOf("beginRouteScrub();") < cleanup.indexOf("cleanupSessionDatabases"));
    assert.ok(
        cleanup.indexOf("cleanupSessionDatabases") <
            cleanup.indexOf("forgetLocalPushState(undefined"),
    );
    assert.ok(forget.indexOf("beginRouteScrub();") < forget.indexOf("forgetLocalSession()"));
    assert.doesNotMatch(forget, /forgetLocalPushState/);
    assert.ok(
        logout.indexOf("forgetLocalPushState(activeService,") <
            logout.indexOf("activeService.logout()"),
    );
    assert.ok(logout.indexOf("clearMemoryDrafts()") < logout.indexOf("activeService.logout()"));
    assert.match(logout, /const inspection = await inspectSession\(\);/);
    assert.match(logout, /local cleanup did not finish/);
    assert.match(
        source,
        /hasLocalPushStateForCleanup\(\) \|\| \(await hasBrowserPushArtifacts\(\)\)/,
    );
    assert.match(source, /inspection\.kind !== "empty"[\s\S]*hasPendingLocalPushCleanup\(\)/);
    assert.match(
        source,
        /await nextService\.start\(\);[\s\S]*hasPendingLocalPushCleanup\(\)[\s\S]*forgetLocalPushState\(nextService,\s*\{\s*abandonMatrixPusherAfterGatewayCleanup: true,\s*\}\)/,
    );
    assert.match(source, /abandonMatrixPusherAfterGatewayCleanup: true/);
    assert.match(
        source,
        /setup\.mode === "migration"[\s\S]*inspectSession\(\)[\s\S]*routeInspection\(inspection, operation\)/,
    );
    assert.match(
        source,
        /if \(logoutInProgress\.current\) \{\s*return;\s*\}[\s\S]*invalidated = true;/,
    );
    assert.match(source, /operation !== operationGeneration\.current/);
    assert.match(source, /persistRemoteLogoutWarning\(\)/);
    assert.match(source, /persistRemoteRefreshWarning\(\)/);
    assert.match(
        source,
        /if \(cancelled \|\| operation !== operationGeneration\.current\)[\s\S]*revokePendingMatrixSession\(redirectSession\)[\s\S]*persistRemotePendingWarning\(\)/,
    );
    assert.match(source, /MatrixSessionRevocationUnconfirmedError/);
    assert.match(
        source,
        /inspection\.kind !== "empty" && inspection\.kind !== "cleanup"[\s\S]*combineSecurityWarnings\(\)[\s\S]*resume: "route"/,
    );
    assert.match(source, /kind: "locked"[\s\S]*error: deferredPusherCleanupError/);
    assert.match(source, /SECURITY ACTION REQUIRED/);
    assert.match(
        source,
        /readAbandonedMatrixPusherWarning\(\)[\s\S]*clearAbandonedMatrixPusherWarning\(\)/,
    );
    assert.match(source, /securityWarning[\s\S]*resume: "connected"[\s\S]*setAppState/);
    assert.match(source, /onCancel: \(\) => void cancelEnrollment\(\)/);
    assert.match(source, /if \(nextService\) \{\s*nextService\.stop\(\);\s*\} else \{/);
    assert.doesNotMatch(source, /nextService\?\.stop\(\);\s*lease\.dispose\(\);/);
    assert.match(source, /window\.addEventListener\("pagehide", scrubForPageHide\)/);
    assert.match(source, /const shutdown = currentService\?\.shutdownForPageHide\(\)/);
    assert.match(source, /pendingServiceRef\.current = nextService/);
    assert.doesNotMatch(invalidation, /pendingServiceRef\.current = null/);
    assert.match(source, /pendingLeaseRef\.current = lease/);
    assert.match(source, /const pendingService = pendingServiceRef\.current/);
    assert.match(source, /const pendingLease = pendingLeaseRef\.current/);
    assert.match(source, /pendingLease\?\.dispose\(\)/);
    assert.match(source, /if \(logoutInProgress\.current\)[\s\S]*persistRemoteLogoutWarning\(\)/);
    assert.match(source, /pendingService\.shutdownForPageHide\(\)/);
    assert.match(source, /shutdown\?\.refreshInFlight \|\| pendingShutdown\?\.refreshInFlight/);
    assert.match(source, /persistRemoteRefreshWarning\(\)/);
    assert.match(source, /currentState\.deviceEnrollment\.prfOutput\.fill\(0\)/);
    assert.match(source, /const pendingUnsealedSessionRef = useRef<PersistedMatrixSession/);
    assert.match(source, /const authenticationCallbackPendingRef = useRef\(false\)/);
    assert.match(source, /const authenticationInFlightRef = useRef\(false\)/);
    assert.ok(
        initialRouteScrub.indexOf("authenticationCallbackPendingRef.current =") <
            initialRouteScrub.indexOf("scrubSensitiveHistoryEntry();"),
    );
    assert.match(
        initialRouteScrub,
        /routeScrubActive\.current &&[\s\S]*!authenticationCallbackPendingRef\.current/,
    );
    assert.match(source, /const vaultOperationAbortRef = useRef<AbortController/);
    assert.match(
        source,
        /const advanceOperation = useCallback[\s\S]*vaultOperationAbortRef\.current\?\.abort\(\)[\s\S]*\+\+operationGeneration\.current/,
    );
    assert.match(
        loginSource,
        /onAuthenticationPendingChange\?\.\(true\)[\s\S]*loginWithPassword[\s\S]*finally[\s\S]*onAuthenticationPendingChange\?\.\(false\)/,
    );
    assert.match(
        source,
        /hasRedirectLoginParameters\([\s\S]*const redirectLogin = completeRedirectLogin\(\)/,
    );
    assert.match(
        callbackBoot,
        /const redirectLogin = completeRedirectLogin\(\);[\s\S]*authenticationCallbackPendingRef\.current = false[\s\S]*await redirectLogin/,
    );
    assert.match(
        callbackBoot,
        /hasRedirectLoginParameters\([\s\S]*\)\) \{\s*try \{\s*scrubRoute\(\);/,
    );
    assert.match(
        source,
        /pendingUnsealedSessionRef\.current = source\.session[\s\S]*await webAuthnPrfSupportHint/,
    );
    assert.match(
        source,
        /operation !== operationGeneration\.current[\s\S]*revokeDiscardedUnsealedSession\(source\.session\)/,
    );
    assert.match(
        source,
        /authenticationInFlightRef\.current \|\|[\s\S]*pendingUnsealedSessionRef\.current \|\|[\s\S]*persistRemotePendingWarning\(\)[\s\S]*pendingUnsealedSessionRef\.current = null[\s\S]*authenticationInFlightRef\.current = false/,
    );
    assert.match(
        source,
        /await createLockedSession[\s\S]*clearPendingUnsealedSession\(setup\.session\)[\s\S]*operation !== operationGeneration\.current/,
    );
    assert.match(
        source,
        /createLockedSession\([\s\S]*signal: abortController\.signal[\s\S]*migrateLegacySession\([\s\S]*signal: abortController\.signal/,
    );
    assert.match(
        source,
        /unlockSession\([\s\S]*signal: abortController\.signal[\s\S]*vaultOperationAbortRef\.current === abortController/,
    );
    assert.match(
        source,
        /error instanceof OAuthPostGrantRevocationUnconfirmedError[\s\S]*persistRemotePendingWarning\(\)[\s\S]*REMOTE_PENDING_WARNING/,
    );
    assert.match(
        source,
        /await beginWebAuthnPrfEnrollment\(\)[\s\S]*operation !== operationGeneration\.current[\s\S]*enrollment\.prfOutput\.fill\(0\)/,
    );
    assert.match(
        source,
        /await completeWebAuthnPrfEnrollment\(pending\)[\s\S]*operation !== operationGeneration\.current[\s\S]*enrollment\.prfOutput\.fill\(0\)/,
    );
    assert.match(
        source,
        /currentState\.kind === "setup" && currentState\.mode === "enrollment"[\s\S]*persistRemotePendingWarning\(\)/,
    );
    assert.match(source, /const handlePageShow = \(event: PageTransitionEvent\)/);
    assert.match(source, /if \(event\.persisted\) \{[\s\S]*window\.location\.reload\(\)/);
    assert.match(source, /window\.addEventListener\("pageshow", handlePageShow\)/);
});

test("new-session enrollment exposes explicit bounded cancellation", () => {
    const markup = renderVault(
        enrollmentProps({
            onCancel: () => undefined,
        }),
    );

    assert.match(markup, />Cancel sign-in and revoke session<\/button>/);
    assert.match(markup, /session and device already exist on the homeserver/);
    assert.match(markup, /revoke the device from another trusted Matrix client/);
});

test("production updates have no manual service-worker gate", async () => {
    const [appSource, notificationsSource] = await Promise.all([
        readFile(APP_SOURCE, "utf8"),
        readFile(new URL("../lib/matrix/notifications.ts", import.meta.url), "utf8"),
    ]);

    assert.doesNotMatch(appSource, /waitingWorker|applyUpdate|controllerchange|Update now/);
    assert.match(
        notificationsSource,
        /const registration = await navigator\.serviceWorker\.register/,
    );
    assert.match(
        notificationsSource,
        /if \(registration\.active && typeof registration\.update === "function"\) \{[\s\S]*registration\.update\(\)/,
    );
});
