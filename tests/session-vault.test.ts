import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, test } from "node:test";
import {
    IDBFactory,
    IDBRequest as FakeIDBRequest,
    IDBTransaction as FakeIDBTransaction,
} from "fake-indexeddb";
import {
    cleanupSessionDatabases,
    completeLocalSessionCleanup,
    createLockedSession,
    createSession,
    deleteSessionRecord,
    forgetLocalSession,
    generateRecoveryKey,
    inspectSession,
    migrateLegacySession,
    randomBase64Url,
    SESSION_VAULT_LOCK_NAME,
    SessionLease,
    SessionVaultError,
    SessionVaultOperationAbortedError,
    unlockSession,
    type LegacySessionCandidate,
    type LockedSessionDescriptor,
} from "../lib/matrix/session-store";
import type { PersistedMatrixSession } from "../lib/matrix/types";
import type { ReadyWebAuthnPrfEnrollment } from "../lib/security/webauthn-prf";

const DATABASE = "sub-etha-session";
const STORE = "private";
const KEY = "matrix-session";

let indexedDbDescriptor: PropertyDescriptor | undefined;
let navigatorDescriptor: PropertyDescriptor | undefined;
let heldLocks: Set<string>;

beforeEach(() => {
    indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    heldLocks = new Set<string>();
    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: new IDBFactory(),
        writable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async <T>(
                    name: string,
                    options: LockOptions,
                    callback: (lock: Lock | null) => T | PromiseLike<T>,
                ): Promise<T> => {
                    if (options.ifAvailable && heldLocks.has(name)) {
                        return callback(null);
                    }

                    heldLocks.add(name);

                    try {
                        return await callback({ name } as Lock);
                    } finally {
                        heldLocks.delete(name);
                    }
                },
            },
        },
    });
});

afterEach(() => {
    if (indexedDbDescriptor) {
        Object.defineProperty(globalThis, "indexedDB", indexedDbDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, "indexedDB");
    }

    if (navigatorDescriptor) {
        Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    } else {
        Reflect.deleteProperty(globalThis, "navigator");
    }
});

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
        transaction.onerror = () => reject(transaction.error ?? new Error("transaction failed"));
    });
}

async function openRaw(version?: number): Promise<IDBDatabase> {
    const request =
        version === undefined ? indexedDB.open(DATABASE) : indexedDB.open(DATABASE, version);

    request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE);
        }
    };

    return requestValue(request);
}

async function putRaw(value: unknown, version?: number): Promise<void> {
    const database = await openRaw(version);

    try {
        const transaction = database.transaction(STORE, "readwrite");
        const completion = transactionDone(transaction);

        transaction.objectStore(STORE).put(value, KEY);
        await completion;
    } finally {
        database.close();
    }
}

async function getRaw(): Promise<unknown> {
    const database = await openRaw();

    try {
        const transaction = database.transaction(STORE, "readonly");
        const completion = transactionDone(transaction);
        const result = await requestValue(transaction.objectStore(STORE).get(KEY));

        await completion;

        return result;
    } finally {
        database.close();
    }
}

async function createNamedDatabase(name: string): Promise<void> {
    const database = await openRawDatabase(name);

    database.close();
}

async function openRawDatabase(name: string): Promise<IDBDatabase> {
    const request = indexedDB.open(name, 1);

    request.onupgradeneeded = () => request.result.createObjectStore("data");

    return requestValue(request);
}

async function databaseNames(): Promise<string[]> {
    return (await indexedDB.databases())
        .map((database) => database.name)
        .filter((name): name is string => typeof name === "string");
}

function gateNextReadwriteCompletion(): {
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
} {
    const prototype = FakeIDBTransaction.prototype as unknown as {
        dispatchEvent(event: Event): boolean;
    };
    const original = prototype.dispatchEvent;
    let release = (): void => undefined;
    let markReached = (): void => undefined;
    let gated = false;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
        markReached = resolve;
    });

    prototype.dispatchEvent = function (this: IDBTransaction, event: Event): boolean {
        if (!gated && this.mode === "readwrite" && event.type === "complete") {
            gated = true;
            markReached();
            void released.then(() => original.call(this, event));

            return true;
        }

        return original.call(this, event);
    };

    return {
        reached,
        release,
        restore: () => {
            prototype.dispatchEvent = original;
        },
    };
}

function gateNextReadwriteRequestSuccess(): {
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
} {
    const prototype = FakeIDBRequest.prototype as unknown as {
        dispatchEvent(event: Event): boolean;
    };
    const original = prototype.dispatchEvent;
    let release = (): void => undefined;
    let markReached = (): void => undefined;
    let gated = false;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
        markReached = resolve;
    });

    prototype.dispatchEvent = function (this: IDBRequest, event: Event): boolean {
        if (!gated && this.transaction?.mode === "readwrite" && event.type === "success") {
            gated = true;
            markReached();
            void released.then(() => original.call(this, event));

            return true;
        }

        return original.call(this, event);
    };

    return {
        reached,
        release,
        restore: () => {
            prototype.dispatchEvent = original;
        },
    };
}

function delayNextRecoveryDerivation(): {
    reached: Promise<void>;
    release: () => void;
    restore: () => void;
} {
    const subtle = crypto.subtle;
    const original = subtle.deriveKey.bind(subtle);
    let release = (): void => undefined;
    let markReached = (): void => undefined;
    let delayed = false;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
        markReached = resolve;
    });

    Object.defineProperty(subtle, "deriveKey", {
        configurable: true,
        value: async (...parameters: Parameters<SubtleCrypto["deriveKey"]>) => {
            if (!delayed && (parameters[0] as { name?: unknown }).name === "PBKDF2") {
                delayed = true;
                markReached();
                await released;
            }

            return original(...parameters);
        },
    });

    return {
        reached,
        release,
        restore: () => {
            Object.defineProperty(subtle, "deriveKey", {
                configurable: true,
                value: original,
            });
        },
    };
}

test("AES helpers retain caller AAD ownership while clearing their copies", async () => {
    const source = await readFile(
        new URL("../lib/security/session-vault-crypto.ts", import.meta.url),
        "utf8",
    );

    assert.equal(
        (source.match(/const ownedAdditionalData = new Uint8Array\(additionalData\);/g) ?? [])
            .length,
        2,
    );
    assert.equal((source.match(/additionalData: ownedAdditionalData/g) ?? []).length, 2);
    assert.equal((source.match(/ownedAdditionalData\.fill\(0\)/g) ?? []).length, 2);
    assert.doesNotMatch(source, /additionalData\.fill\(0\)/);
});

function session(suffix = "original"): PersistedMatrixSession {
    return createSession({
        baseUrl: "https://matrix.example",
        userId: `@USER_CANARY_${suffix}:matrix.example`,
        deviceId: `DEVICE_CANARY_${suffix}`,
        accessToken: `ACCESS_TOKEN_CANARY_${suffix}`,
        refreshToken: `REFRESH_TOKEN_CANARY_${suffix}`,
        expiresAt: 1_900_000_000_000,
        authKind: "token",
    });
}

function oauthSession(suffix = "oauth"): PersistedMatrixSession {
    return {
        ...session(suffix),
        authKind: "oauth",
        oauth: {
            clientId: "client-id",
            deviceId: `OAUTH_DEVICE_${suffix}`,
            redirectUri: "https://sub-etha.example/",
            metadata: {
                authorization_endpoint: "https://issuer.example/authorize",
                code_challenge_methods_supported: ["S256"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                issuer: "https://issuer.example/",
                registration_endpoint: "https://issuer.example/register",
                response_modes_supported: ["query", "fragment"],
                response_types_supported: ["code"],
                revocation_endpoint: "https://issuer.example/revoke",
                token_endpoint: "https://issuer.example/token",
            },
        },
    };
}

function legacyPlaintext(
    sessionValue: PersistedMatrixSession,
): Omit<PersistedMatrixSession, "cryptoDatabasePrefix"> {
    const clone: Partial<PersistedMatrixSession> = { ...sessionValue };

    delete clone.cryptoDatabasePrefix;

    return clone as Omit<PersistedMatrixSession, "cryptoDatabasePrefix">;
}

function locked(inspection: Awaited<ReturnType<typeof inspectSession>>): LockedSessionDescriptor {
    assert.equal(inspection.kind, "locked");

    return inspection as LockedSessionDescriptor;
}

function legacy(inspection: Awaited<ReturnType<typeof inspectSession>>): LegacySessionCandidate {
    assert.equal(inspection.kind, "legacy");

    return inspection as LegacySessionCandidate;
}

test("recovery-key vault round trips without plaintext canaries", async () => {
    const original = session();
    const recoveryKey = generateRecoveryKey();
    const lease = await createLockedSession(original, recoveryKey);
    const rawJson = JSON.stringify(await getRaw());

    assert.equal(rawJson.includes(original.accessToken), false);
    assert.equal(rawJson.includes(original.refreshToken!), false);
    assert.equal(rawJson.includes(original.cryptoStorageKey), false);
    assert.equal(rawJson.includes(original.userId), false);
    assert.equal(rawJson.includes(original.deviceId), false);
    assert.equal(rawJson.includes(recoveryKey), false);

    lease.dispose();
    const reopened = await unlockSession(locked(await inspectSession()), {
        kind: "recovery-key",
        recoveryKey,
    });

    assert.equal(reopened.session.accessToken, original.accessToken);
    assert.equal(reopened.session.refreshToken, original.refreshToken);
    assert.equal(reopened.session.cryptoStorageKey, original.cryptoStorageKey);
    assert.equal(reopened.session.cryptoDatabasePrefix, original.cryptoDatabasePrefix);
    assert.equal(reopened.revision, 1);
});

test("recovery-key input is exact UTF-8 without normalization", async () => {
    const composed = "caf\u00e9 secret";
    const decomposed = "cafe\u0301 secret";
    const lease = await createLockedSession(session(), composed);

    lease.dispose();
    await assert.rejects(
        unlockSession(locked(await inspectSession()), {
            kind: "recovery-key",
            recoveryKey: decomposed,
        }),
        (error: unknown) => error instanceof SessionVaultError && error.code === "authentication",
    );
});

test("optional WebAuthn PRF material is independently wrapped and payload-authenticated", async () => {
    const original = session("prf");
    const recoveryKey = generateRecoveryKey();
    const prfOutput = new Uint8Array(32).fill(0x41);
    const rawPrfCanary = "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE";
    const enrollment: ReadyWebAuthnPrfEnrollment = {
        kind: "ready",
        credentialId: randomBase64Url(32),
        transports: ["internal"],
        rpId: "sub-etha.example",
        prfInput: randomBase64Url(32),
        prfOutput,
    };
    const lease = await createLockedSession(original, recoveryKey, enrollment);
    const pristine = structuredClone(await getRaw()) as {
        unlockSlots: Array<{
            kind: string;
            credentialId?: string;
            transports?: AuthenticatorTransport[];
        }>;
    };
    const rawJson = JSON.stringify(pristine);

    assert.equal(pristine.unlockSlots.length, 2);
    assert.equal(
        pristine.unlockSlots.filter((slot) => slot.kind === "recovery-key-pbkdf2").length,
        1,
    );
    assert.equal(pristine.unlockSlots.filter((slot) => slot.kind === "webauthn-prf").length, 1);
    assert.equal(rawJson.includes(rawPrfCanary), false);
    assert.equal(
        prfOutput.every((byte) => byte === 0),
        true,
    );

    lease.dispose();
    const recovered = await unlockSession(locked(await inspectSession()), {
        kind: "recovery-key",
        recoveryKey,
    });

    assert.equal(recovered.session.accessToken, original.accessToken);
    recovered.dispose();

    const tampered = structuredClone(pristine);
    const prfSlot = tampered.unlockSlots.find((slot) => slot.kind === "webauthn-prf");

    assert.ok(prfSlot);
    prfSlot.credentialId = randomBase64Url(32);
    await putRaw(tampered);
    await assert.rejects(
        unlockSession(locked(await inspectSession()), { kind: "recovery-key", recoveryKey }),
        (error: unknown) => error instanceof SessionVaultError && error.code === "authentication",
    );

    const sparseTransportRecord = structuredClone(pristine);
    const sparsePrfSlot = sparseTransportRecord.unlockSlots.find(
        (slot) => slot.kind === "webauthn-prf",
    );

    assert.ok(sparsePrfSlot?.transports);
    sparsePrfSlot.transports.length = 2;
    Object.defineProperty(sparsePrfSlot.transports, "compensating", {
        enumerable: true,
        value: "not-an-array-index",
    });
    await putRaw(sparseTransportRecord);
    assert.equal((await inspectSession()).kind, "corrupt");
});

test("recovery input rejects oversized strings before UTF-8 encoding work", async () => {
    await assert.rejects(
        createLockedSession(session("oversized-recovery"), "x".repeat(1_025)),
        (error: unknown) => error instanceof SessionVaultError && error.code === "invalid-input",
    );
});

test("wrong recovery key and payload or AAD tampering fail authentication", async () => {
    const recoveryKey = generateRecoveryKey();
    const lease = await createLockedSession(session(), recoveryKey);

    lease.dispose();
    const descriptor = locked(await inspectSession());

    await assert.rejects(
        unlockSession(descriptor, { kind: "recovery-key", recoveryKey: generateRecoveryKey() }),
        (error: unknown) => error instanceof SessionVaultError && error.code === "authentication",
    );

    const raw = (await getRaw()) as Record<string, unknown>;
    const payload = raw.payload as { ciphertext: string };

    payload.ciphertext = `${payload.ciphertext.slice(0, -1)}${
        payload.ciphertext.endsWith("A") ? "B" : "A"
    }`;
    await putRaw(raw);
    await assert.rejects(
        unlockSession(locked(await inspectSession()), { kind: "recovery-key", recoveryKey }),
        (error: unknown) => error instanceof SessionVaultError && error.code === "authentication",
    );
});

test("cross-record ciphertext and slot transplants fail AAD authentication", async () => {
    const firstRecoveryKey = generateRecoveryKey();
    const firstLease = await createLockedSession(session("aad-first"), firstRecoveryKey);

    firstLease.dispose();
    const firstRecord = structuredClone(await getRaw()) as Record<string, unknown>;

    Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: new IDBFactory(),
    });
    const secondLease = await createLockedSession(session("aad-second"), generateRecoveryKey());

    secondLease.dispose();
    const secondRecord = structuredClone(await getRaw()) as Record<string, unknown>;
    const transplanted = {
        ...secondRecord,
        payload: firstRecord.payload,
        unlockSlots: firstRecord.unlockSlots,
    };

    await putRaw(transplanted);
    await assert.rejects(
        unlockSession(locked(await inspectSession()), {
            kind: "recovery-key",
            recoveryKey: firstRecoveryKey,
        }),
        (error: unknown) => error instanceof SessionVaultError && error.code === "authentication",
    );
});

test("strict record validation runs before recovery KDF", async () => {
    const malformed = {
        kind: "locked-matrix-session",
        schemaVersion: 1,
        recordId: "not-an-id",
        revision: 1,
        storage: { cryptoDatabasePrefix: "sub-etha-crypto-safe" },
        payload: { algorithm: "AES-256-GCM", iv: "bad", ciphertext: "bad" },
        unlockSlots: [
            {
                kind: "recovery-key-pbkdf2",
                slotId: "bad",
                salt: "bad",
                iterations: 1,
                wrappedDek: { algorithm: "AES-256-GCM", iv: "bad", ciphertext: "bad" },
            },
        ],
    };

    await putRaw(malformed, 1);
    const inspection = await inspectSession();

    assert.equal(inspection.kind, "corrupt");
});

test("strict validation rejects short wrapped keys and sparse slot arrays", async () => {
    const recoveryKey = generateRecoveryKey();
    const lease = await createLockedSession(session("strict-shapes"), recoveryKey);

    lease.dispose();
    const shortWrapped = structuredClone(await getRaw()) as {
        unlockSlots: Array<{ wrappedDek: { ciphertext: string } }>;
    };

    shortWrapped.unlockSlots[0].wrappedDek.ciphertext = "A".repeat(22);
    await putRaw(shortWrapped);
    assert.equal((await inspectSession()).kind, "corrupt");

    const freshFactory = new IDBFactory();

    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: freshFactory });
    const validLease = await createLockedSession(session("sparse"), recoveryKey);

    validLease.dispose();
    const sparse = structuredClone(await getRaw()) as { unlockSlots: unknown[] };

    sparse.unlockSlots.length = 2;
    Object.defineProperty(sparse.unlockSlots, "compensating", {
        enumerable: true,
        value: "not-an-array-index",
    });
    await putRaw(sparse);
    assert.equal((await inspectSession()).kind, "corrupt");
});

test("legacy OAuth validation rejects undefined requirements, noncanonical arrays, and unsafe URLs", async () => {
    const valid = oauthSession("strict-oauth");
    const storedLegacy = legacyPlaintext(valid);

    await putRaw(storedLegacy, 1);
    assert.equal((await inspectSession()).kind, "legacy");

    const extendedMetadata = structuredClone(storedLegacy) as unknown as {
        oauth: { metadata: Record<string, unknown> };
    };

    extendedMetadata.oauth.metadata.scopes_supported = ["openid", "urn:matrix:client:api:*"];
    await putRaw(extendedMetadata);
    const extendedInspection = await inspectSession();

    assert.equal(extendedInspection.kind, "legacy");

    if (extendedInspection.kind === "legacy") {
        assert.equal(
            "scopes_supported" in (extendedInspection.session.oauth?.metadata ?? {}),
            false,
        );
    }

    const missingRequiredUrl = structuredClone(storedLegacy) as unknown as {
        oauth: { metadata: Record<string, unknown> };
    };

    missingRequiredUrl.oauth.metadata.authorization_endpoint = undefined;
    await putRaw(missingRequiredUrl);
    assert.equal((await inspectSession()).kind, "corrupt");

    const sparseRequiredArray = structuredClone(storedLegacy) as unknown as {
        oauth: { metadata: Record<string, unknown> };
    };
    const grantTypes = ["authorization_code", "refresh_token"];

    grantTypes.length = 3;
    Object.defineProperty(grantTypes, "compensating", {
        enumerable: true,
        value: "not-an-array-index",
    });
    sparseRequiredArray.oauth.metadata.grant_types_supported = grantTypes;
    await putRaw(sparseRequiredArray);
    assert.equal((await inspectSession()).kind, "corrupt");

    const queriedIssuer = structuredClone(storedLegacy) as unknown as {
        oauth: { metadata: Record<string, unknown> };
    };

    queriedIssuer.oauth.metadata.issuer = "https://issuer.example/?tenant=unsafe";
    await putRaw(queriedIssuer);
    assert.equal((await inspectSession()).kind, "corrupt");

    const insecureRedirect = structuredClone(storedLegacy) as unknown as {
        oauth: { redirectUri: string };
    };

    insecureRedirect.oauth.redirectUri = "http://sub-etha.example/callback";
    await putRaw(insecureRedirect);
    assert.equal((await inspectSession()).kind, "corrupt");
});

test("new OAuth enrollment ignores discovery metadata extensions", async () => {
    const extended = oauthSession("extended-enrollment") as PersistedMatrixSession & {
        oauth: NonNullable<PersistedMatrixSession["oauth"]> & {
            metadata: Record<string, unknown>;
        };
    };

    extended.oauth.metadata.scopes_supported = ["openid", "urn:matrix:client:api:*"];
    const lease = await createLockedSession(extended, generateRecoveryKey());

    assert.equal("scopes_supported" in (lease.session.oauth?.metadata ?? {}), false);
    lease.dispose();
});

test("v1 plaintext migration preserves exact Rust prefix/key and commits atomically", async () => {
    const original = session("legacy");
    const storedLegacy = legacyPlaintext(original);

    await putRaw(storedLegacy, 1);
    const databaseBefore = await openRaw();

    assert.equal(databaseBefore.version, 1);
    databaseBefore.close();

    const candidate = legacy(await inspectSession());
    const expectedName = "_USER_CANARY_legacy_matrix_example-DEVICE_CANARY_legacy";

    assert.equal(candidate.cryptoDatabasePrefix, `sub-etha-crypto-${expectedName}`);
    assert.equal(candidate.legacySyncDatabase, `matrix-js-sdk:sub-etha-sync-${expectedName}`);
    assert.equal(candidate.session.cryptoStorageKey, original.cryptoStorageKey);

    const recoveryKey = generateRecoveryKey();
    const lease = await migrateLegacySession(candidate, recoveryKey);
    const rawJson = JSON.stringify(await getRaw());

    assert.equal(rawJson.includes(original.accessToken), false);
    assert.equal(rawJson.includes(original.cryptoStorageKey), false);
    assert.equal(lease.cryptoDatabasePrefix, candidate.cryptoDatabasePrefix);
    assert.equal(lease.session.cryptoStorageKey, original.cryptoStorageKey);

    const databaseAfter = await openRaw();

    assert.equal(databaseAfter.version, 2);
    databaseAfter.close();
});

test("migration CAS conflict leaves a concurrent legacy winner untouched", async () => {
    const first = session("legacy-first");
    const second = session("legacy-second");
    const firstPlaintext = legacyPlaintext(first);
    const secondPlaintext = legacyPlaintext(second);

    await putRaw(firstPlaintext, 1);
    const candidate = legacy(await inspectSession());

    await putRaw(secondPlaintext);
    await assert.rejects(
        migrateLegacySession(candidate, generateRecoveryKey()),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );
    assert.deepEqual(await getRaw(), secondPlaintext);
});

test("migration rejects a forged candidate before sealing and preserves plaintext winner", async () => {
    const original = session("legacy-forged");
    const storedLegacy = legacyPlaintext(original);

    await putRaw(storedLegacy, 1);
    const candidate = legacy(await inspectSession());
    const forgedSession = {
        ...candidate.session,
        accessToken: "ACCESS_TOKEN_CANARY_FORGED",
    };

    await assert.rejects(
        migrateLegacySession({ ...candidate, session: forgedSession }, generateRecoveryKey()),
        (error: unknown) => error instanceof SessionVaultError && error.code === "invalid-input",
    );
    assert.deepEqual(await getRaw(), storedLegacy);
});

test("revision CAS blocks stale reseal and deletion without resurrection", async () => {
    const original = session("cas");
    const recoveryKey = generateRecoveryKey();
    const first = await createLockedSession(original, recoveryKey);
    const second = await unlockSession(locked(await inspectSession()), {
        kind: "recovery-key",
        recoveryKey,
    });
    const refreshed = {
        ...original,
        accessToken: "ACCESS_TOKEN_CANARY_refreshed",
        refreshToken: "REFRESH_TOKEN_CANARY_refreshed",
    };

    await first.reseal(refreshed, "token-refresh");
    assert.equal(first.revision, 2);
    assert.equal(first.session.accessToken, refreshed.accessToken);

    await assert.rejects(
        second.reseal({ ...original, accessToken: "ACCESS_TOKEN_CANARY_stale" }, "token-refresh"),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );
    await assert.rejects(
        deleteSessionRecord(second),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );

    const deletion = await deleteSessionRecord(first);
    const descriptor = deletion.cleanup;

    assert.equal(descriptor.kind, "cleanup");
    assert.equal(deletion.session.accessToken, refreshed.accessToken);
    assert.equal(deletion.session.refreshToken, refreshed.refreshToken);
    await assert.rejects(
        first.reseal(refreshed, "token-refresh"),
        (error: unknown) => error instanceof SessionVaultError && error.code === "disposed",
    );
    assert.equal((await inspectSession()).kind, "cleanup");
});

test("lease freshness rejects an exact stale record before runtime ownership", async () => {
    const original = session("freshness");
    const recoveryKey = generateRecoveryKey();
    const current = await createLockedSession(original, recoveryKey);
    const stale = await unlockSession(locked(await inspectSession()), {
        kind: "recovery-key",
        recoveryKey,
    });

    await current.assertCurrent();
    await current.reseal(
        { ...original, accessToken: "ACCESS_TOKEN_CANARY_freshness-new" },
        "token-refresh",
    );
    await assert.rejects(
        stale.assertCurrent(),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );
});

test("dispose during a durable reseal resolves committed without repopulating lease plaintext", async () => {
    const original = session("dispose-race");
    const recoveryKey = generateRecoveryKey();
    const lease = await createLockedSession(original, recoveryKey);
    const refreshed = {
        ...original,
        accessToken: "ACCESS_TOKEN_CANARY_dispose-race-refreshed",
    };
    const gate = gateNextReadwriteCompletion();
    const nativeStructuredClone = globalThis.structuredClone;
    const cloneDescriptor = Object.getOwnPropertyDescriptor(globalThis, "structuredClone");
    let retainedPlaintext = false;

    Object.defineProperty(globalThis, "structuredClone", {
        configurable: true,
        value: ((value: unknown) => {
            if (
                value &&
                typeof value === "object" &&
                (value as { accessToken?: unknown }).accessToken === refreshed.accessToken
            ) {
                retainedPlaintext = true;
            }

            return nativeStructuredClone(value);
        }) as typeof structuredClone,
    });

    try {
        const reseal = lease.reseal(refreshed, "token-refresh");

        await gate.reached;
        lease.dispose();
        gate.release();
        await reseal;
        assert.equal(retainedPlaintext, false);
        assert.throws(() => lease.session, /disposed/i);
    } finally {
        gate.release();
        gate.restore();

        if (cloneDescriptor) {
            Object.defineProperty(globalThis, "structuredClone", cloneDescriptor);
        } else {
            Object.defineProperty(globalThis, "structuredClone", {
                configurable: true,
                value: nativeStructuredClone,
            });
        }
    }

    const descriptor = locked(await inspectSession());

    assert.equal(descriptor.revision, 2);
    const reopened = await unlockSession(descriptor, { kind: "recovery-key", recoveryKey });

    assert.equal(reopened.session.accessToken, refreshed.accessToken);
    reopened.dispose();
});

test("reseal rejects immutable identity, crypto, and OAuth changes", async () => {
    const original = session("immutable");
    const lease = await createLockedSession(original, generateRecoveryKey());

    for (const changed of [
        { ...original, baseUrl: "https://other.example" },
        { ...original, deviceId: "OTHER_DEVICE" },
        { ...original, cryptoStorageKey: generateRecoveryKey() },
        { ...original, cryptoDatabasePrefix: "sub-etha-crypto-other" },
        { ...original, authKind: "password" as const },
    ]) {
        await assert.rejects(
            lease.reseal(changed, "token-refresh"),
            (error: unknown) =>
                error instanceof SessionVaultError && error.code === "invalid-input",
        );
    }
});

test("dispose makes every getter and operation fail", async () => {
    const original = session("dispose");
    const lease = await createLockedSession(original, generateRecoveryKey());

    lease.dispose();
    assert.throws(() => lease.session, /disposed/i);
    assert.throws(() => lease.recordId, /disposed/i);
    assert.throws(() => lease.revision, /disposed/i);
    assert.throws(() => lease.cryptoDatabasePrefix, /disposed/i);
    await assert.rejects(lease.assertCurrent(), /disposed/i);
    await assert.rejects(lease.reseal(original, "token-refresh"), /disposed/i);
    await assert.rejects(deleteSessionRecord(lease), /disposed/i);
});

test("forget converts legacy and corrupt records to non-plaintext tombstones", async () => {
    const original = session("forget");
    const storedLegacy = legacyPlaintext(original);

    await putRaw(storedLegacy, 1);
    await forgetLocalSession();
    const cleanup = await inspectSession();

    assert.equal(cleanup.kind, "cleanup");
    assert.equal(JSON.stringify(await getRaw()).includes(original.accessToken), false);

    await putRaw({ invalid: "ACCESS_TOKEN_CANARY_corrupt" });
    const corruptCleanup = await forgetLocalSession();

    assert.equal(corruptCleanup.scope, "all-owned");
    assert.equal((await inspectSession()).kind, "cleanup");
    assert.equal(JSON.stringify(await getRaw()).includes("ACCESS_TOKEN_CANARY_corrupt"), false);
});

test("forget cannot tombstone while the origin-wide vault lock is held", async () => {
    const original = session("forget-owned");

    await createLockedSession(original, generateRecoveryKey());
    const before = await getRaw();
    let releaseOwnership: () => void = () => undefined;
    let reportOwned: () => void = () => undefined;
    const ownershipReleased = new Promise<void>((resolve) => {
        releaseOwnership = resolve;
    });
    const owned = new Promise<void>((resolve) => {
        reportOwned = resolve;
    });
    const ownership = navigator.locks.request(
        SESSION_VAULT_LOCK_NAME,
        { ifAvailable: true },
        async (lock) => {
            assert.ok(lock);
            reportOwned();
            await ownershipReleased;
        },
    );

    await owned;
    await assert.rejects(
        forgetLocalSession(),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );
    assert.deepEqual(await getRaw(), before);

    releaseOwnership();
    await ownership;
});

test("forget fails closed without Web Locks and preserves the current record", async () => {
    const original = session("forget-no-locks");

    await createLockedSession(original, generateRecoveryKey());
    const before = await getRaw();

    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await assert.rejects(
        forgetLocalSession(),
        (error: unknown) => error instanceof SessionVaultError && error.code === "unavailable",
    );
    assert.deepEqual(await getRaw(), before);
});

test("new enrollment holds vault ownership from initial-state check through commit", async () => {
    const delayed = delayNextRecoveryDerivation();

    try {
        const enrollment = createLockedSession(session("enrollment-owned"), generateRecoveryKey());

        await delayed.reached;
        await assert.rejects(
            forgetLocalSession(),
            (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
        );
        delayed.release();

        const lease = await enrollment;

        assert.equal(lease.session.userId, "@USER_CANARY_enrollment-owned:matrix.example");
        assert.equal((await inspectSession()).kind, "locked");
    } finally {
        delayed.release();
        delayed.restore();
    }
});

test("enrollment fails closed when Web Locks are unavailable or busy", async () => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
    await assert.rejects(
        createLockedSession(session("enrollment-no-locks"), generateRecoveryKey()),
        (error: unknown) => error instanceof SessionVaultError && error.code === "unavailable",
    );
    assert.equal(await getRaw(), undefined);

    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            locks: {
                request: async <T>(
                    _name: string,
                    _options: LockOptions,
                    callback: (lock: Lock | null) => T | PromiseLike<T>,
                ): Promise<T> => callback(null),
            },
        },
    });
    await assert.rejects(
        createLockedSession(session("enrollment-busy"), generateRecoveryKey()),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );
    assert.equal(await getRaw(), undefined);
});

test("tampered locked cleanup metadata is never used before authentication", async () => {
    const target = "matrix-js-sdk:sub-etha-sync-_tamper_target";
    const unrelated = "other-app-tamper-target";
    const lease = await createLockedSession(session("tampered-storage"), generateRecoveryKey());

    lease.dispose();
    await createNamedDatabase(target);
    await createNamedDatabase(unrelated);

    const tampered = structuredClone(await getRaw()) as {
        storage: { legacySyncDatabase?: string };
    };

    tampered.storage.legacySyncDatabase = target;
    await putRaw(tampered);

    await assert.rejects(
        unlockSession(locked(await inspectSession()), {
            kind: "recovery-key",
            recoveryKey: generateRecoveryKey(),
        }),
        (error: unknown) => error instanceof SessionVaultError,
    );
    assert.equal((await databaseNames()).includes(target), true);

    const cleanup = await forgetLocalSession();

    assert.equal(cleanup.scope, "all-owned");
    assert.equal(cleanup.cryptoDatabasePrefix, undefined);
    assert.equal(cleanup.legacySyncDatabase, undefined);
    await cleanupSessionDatabases(cleanup);
    assert.equal((await databaseNames()).includes(target), false);
    assert.equal((await databaseNames()).includes(unrelated), true);
});

test("all-owned reset removes only canonical Sub-Etha Matrix databases and survives reload", async () => {
    const lease = await createLockedSession(session("all-owned"), generateRecoveryKey());
    const ownedLegacy = "matrix-js-sdk:sub-etha-sync-owned_reset";
    const ownedRust = "sub-etha-crypto-owned_reset::matrix-sdk-crypto";
    const ownedRustMeta = "sub-etha-crypto-owned_reset::matrix-sdk-crypto-meta";
    const nearMissRust = "sub-etha-crypto-owned_reset::matrix-sdk-crypto-decoy";
    const unrelated = "other-application-database";

    lease.dispose();
    await Promise.all(
        [ownedLegacy, ownedRust, ownedRustMeta, nearMissRust, unrelated].map(createNamedDatabase),
    );

    const cleanup = await forgetLocalSession();
    const resumed = await inspectSession();

    assert.equal(cleanup.scope, "all-owned");
    assert.deepEqual(resumed, cleanup);

    await cleanupSessionDatabases(resumed as typeof cleanup);
    const names = await databaseNames();

    assert.equal(names.includes(ownedLegacy), false);
    assert.equal(names.includes(ownedRust), false);
    assert.equal(names.includes(ownedRustMeta), false);
    assert.equal(names.includes(nearMissRust), true);
    assert.equal(names.includes(unrelated), true);
    await completeLocalSessionCleanup(cleanup);
    assert.equal((await inspectSession()).kind, "empty");
});

test("all-owned cleanup ownership prevents a delayed cleaner from deleting a fresh session", async () => {
    const original = await createLockedSession(session("cleanup-race-old"), generateRecoveryKey());
    const oldRust = `${original.cryptoDatabasePrefix}::matrix-sdk-crypto`;

    original.dispose();
    await createNamedDatabase(oldRust);
    const cleanup = await forgetLocalSession();
    const nativeDatabases = indexedDB.databases.bind(indexedDB);
    let reportEnumerationStarted = (): void => undefined;
    let releaseEnumeration = (): void => undefined;
    const enumerationStarted = new Promise<void>((resolve) => {
        reportEnumerationStarted = resolve;
    });
    const enumerationReleased = new Promise<void>((resolve) => {
        releaseEnumeration = resolve;
    });

    Object.defineProperty(indexedDB, "databases", {
        configurable: true,
        value: async () => {
            reportEnumerationStarted();
            await enumerationReleased;

            return nativeDatabases();
        },
    });

    const delayedCleanup = cleanupSessionDatabases(cleanup);

    await enumerationStarted;
    await assert.rejects(
        cleanupSessionDatabases(cleanup),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );

    // Even if another tab advances the marker, the cleaner still owns the vault lock,
    // so a fresh session cannot be enrolled inside its enumeration/deletion window.
    await completeLocalSessionCleanup(cleanup);
    await assert.rejects(
        createLockedSession(session("cleanup-race-too-early"), generateRecoveryKey()),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );

    releaseEnumeration();
    await delayedCleanup;
    assert.equal((await databaseNames()).includes(oldRust), false);

    const fresh = await createLockedSession(session("cleanup-race-fresh"), generateRecoveryKey());
    const freshRust = `${fresh.cryptoDatabasePrefix}::matrix-sdk-crypto`;

    fresh.dispose();
    await createNamedDatabase(freshRust);
    await assert.rejects(cleanupSessionDatabases(cleanup), SessionVaultError);
    assert.equal((await databaseNames()).includes(freshRust), true);
});

test("exact cleanup ownership fences a delayed delete from a replacement session", async () => {
    const oldSession = session("exact-cleanup-race-old");
    const lease = await createLockedSession(oldSession, generateRecoveryKey());
    const oldRust = `${lease.cryptoDatabasePrefix}::matrix-sdk-crypto`;

    await createNamedDatabase(oldRust);
    const { cleanup } = await deleteSessionRecord(lease);
    const nativeDeleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    let reportDeletionStarted = (): void => undefined;
    let releaseDeletion = (): void => undefined;
    let delayedOnce = false;
    const deletionStarted = new Promise<void>((resolve) => {
        reportDeletionStarted = resolve;
    });
    const deletionReleased = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
    });

    Object.defineProperty(indexedDB, "deleteDatabase", {
        configurable: true,
        value: (name: string): IDBOpenDBRequest => {
            if (name !== oldRust || delayedOnce) {
                return nativeDeleteDatabase(name);
            }

            delayedOnce = true;
            const delayedRequest = {} as IDBOpenDBRequest;

            reportDeletionStarted();
            void deletionReleased.then(() => {
                const request = nativeDeleteDatabase(name);

                request.onsuccess = (event) =>
                    delayedRequest.onsuccess?.call(delayedRequest, event);
                request.onerror = (event) => delayedRequest.onerror?.call(delayedRequest, event);
                request.onblocked = (event) =>
                    delayedRequest.onblocked?.call(delayedRequest, event);
            });

            return delayedRequest;
        },
    });

    try {
        const delayedCleanup = cleanupSessionDatabases(cleanup);

        await deletionStarted;
        await assert.rejects(
            cleanupSessionDatabases(cleanup),
            (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
        );

        // A competing tab can advance only the marker transaction. Enrollment still cannot
        // reuse the old exact database name until the cleaner releases vault ownership.
        await completeLocalSessionCleanup(cleanup);
        await assert.rejects(
            createLockedSession(
                {
                    ...session("exact-cleanup-race-too-early"),
                    cryptoDatabasePrefix: oldSession.cryptoDatabasePrefix,
                },
                generateRecoveryKey(),
            ),
            (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
        );

        releaseDeletion();
        await delayedCleanup;
        assert.equal((await databaseNames()).includes(oldRust), false);

        const fresh = await createLockedSession(
            {
                ...session("exact-cleanup-race-fresh"),
                cryptoDatabasePrefix: oldSession.cryptoDatabasePrefix,
            },
            generateRecoveryKey(),
        );
        const freshRust = `${fresh.cryptoDatabasePrefix}::matrix-sdk-crypto`;

        fresh.dispose();
        await createNamedDatabase(freshRust);
        await assert.rejects(cleanupSessionDatabases(cleanup), SessionVaultError);
        assert.equal((await databaseNames()).includes(freshRust), true);
    } finally {
        releaseDeletion();
        Object.defineProperty(indexedDB, "deleteDatabase", {
            configurable: true,
            value: nativeDeleteDatabase,
        });
    }
});

test("forgetting an empty or completed vault still creates a retryable all-owned cleanup", async () => {
    const emptyCleanup = await forgetLocalSession();

    assert.equal(emptyCleanup.scope, "all-owned");
    assert.deepEqual(await inspectSession(), emptyCleanup);
    await cleanupSessionDatabases(emptyCleanup);
    await completeLocalSessionCleanup(emptyCleanup);

    const completedCleanup = await forgetLocalSession();

    assert.equal(completedCleanup.scope, "all-owned");
    assert.deepEqual(await inspectSession(), completedCleanup);
    await cleanupSessionDatabases(completedCleanup);
});

test("all-owned reset fails closed when database enumeration is unavailable", async () => {
    const lease = await createLockedSession(
        session("enumeration-unavailable"),
        generateRecoveryKey(),
    );

    lease.dispose();
    const cleanup = await forgetLocalSession();
    const factory = indexedDB;

    Object.defineProperty(factory, "databases", { configurable: true, value: undefined });
    await assert.rejects(
        cleanupSessionDatabases(cleanup),
        (error: unknown) =>
            error instanceof SessionVaultError &&
            error.code === "unavailable" &&
            /Clear this site's data/.test(error.message),
    );
    assert.deepEqual(await inspectSession(), cleanup);
});

test("malformed all-owned cleanup scopes fail validation without deleting databases", async () => {
    const unrelated = "other-app-survives-malformed-cleanup";

    await createNamedDatabase(unrelated);
    await putRaw({
        kind: "matrix-session-tombstone",
        schemaVersion: 1,
        recordId: randomBase64Url(16),
        revision: 1,
        pendingCleanup: { scope: "all-owned", injectedTarget: unrelated },
    });
    assert.equal((await inspectSession()).kind, "corrupt");
    assert.equal((await databaseNames()).includes(unrelated), true);
});

test("migration stays retryable and gates access until authenticated legacy cleanup succeeds", async () => {
    const original = session("cleanup-gate");
    const storedLegacy = legacyPlaintext(original);

    await putRaw(storedLegacy, 1);
    const candidate = legacy(await inspectSession());

    await createNamedDatabase(candidate.legacySyncDatabase);

    const blocker = await openRawDatabase(candidate.legacySyncDatabase);
    const recoveryKey = generateRecoveryKey();

    await assert.rejects(
        migrateLegacySession(candidate, recoveryKey),
        (error: unknown) => error instanceof SessionVaultError && error.code === "unavailable",
    );

    assert.equal((await databaseNames()).includes(candidate.legacySyncDatabase), true);
    assert.equal((await inspectSession()).kind, "legacy");

    blocker.close();
    const reopened = await migrateLegacySession(candidate, recoveryKey);

    assert.equal(reopened.session.accessToken, original.accessToken);
    assert.equal((await databaseNames()).includes(candidate.legacySyncDatabase), false);
    assert.equal((await inspectSession()).kind, "locked");
});

test("cleanup deletes only tombstone-authorized legacy and Rust databases", async () => {
    const original = session("cleanup-targets");
    const storedLegacy = legacyPlaintext(original);

    await putRaw(storedLegacy, 1);
    const candidate = legacy(await inspectSession());

    await createNamedDatabase(candidate.legacySyncDatabase);
    const lease = await migrateLegacySession(candidate, generateRecoveryKey());

    assert.equal((await databaseNames()).includes(candidate.legacySyncDatabase), false);

    const rustDatabase = `${lease.cryptoDatabasePrefix}::matrix-sdk-crypto`;
    const rustMetaDatabase = `${lease.cryptoDatabasePrefix}::matrix-sdk-crypto-meta`;
    const decoyDatabase = `${lease.cryptoDatabasePrefix}::matrix-sdk-crypto-decoy`;

    await createNamedDatabase(candidate.legacySyncDatabase);
    await createNamedDatabase(rustDatabase);
    await createNamedDatabase(rustMetaDatabase);
    await createNamedDatabase(decoyDatabase);
    const { cleanup } = await deleteSessionRecord(lease);

    await assert.rejects(
        cleanupSessionDatabases({ ...cleanup, revision: cleanup.revision + 1 }),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );
    let names = await databaseNames();

    assert.equal(names.includes(candidate.legacySyncDatabase), true);
    assert.equal(names.includes(rustDatabase), true);
    assert.equal(names.includes(rustMetaDatabase), true);

    await cleanupSessionDatabases(cleanup);
    names = await databaseNames();
    assert.equal(names.includes(candidate.legacySyncDatabase), false);
    assert.equal(names.includes(rustDatabase), false);
    assert.equal(names.includes(rustMetaDatabase), false);
    assert.equal(names.includes(decoyDatabase), true);

    await completeLocalSessionCleanup(cleanup);
    assert.equal((await inspectSession()).kind, "empty");
});

test("a completed cleanup tombstone permits a fresh locked login", async () => {
    const first = session("first-login");
    const lease = await createLockedSession(first, generateRecoveryKey());
    const { cleanup } = await deleteSessionRecord(lease);

    await assert.rejects(
        createLockedSession(session("too-early"), generateRecoveryKey()),
        (error: unknown) => error instanceof SessionVaultError && error.code === "conflict",
    );

    await completeLocalSessionCleanup(cleanup);
    const replacement = session("replacement");
    const replacementLease = await createLockedSession(replacement, generateRecoveryKey());

    assert.equal(replacementLease.session.accessToken, replacement.accessToken);
});

test("cancelled enrollment never commits or publishes a lease", async () => {
    const controller = new AbortController();
    const commitRequest = gateNextReadwriteRequestSuccess();

    try {
        const enrollment = createLockedSession(
            session("cancelled-enrollment"),
            generateRecoveryKey(),
            undefined,
            { signal: controller.signal },
        );

        await commitRequest.reached;
        controller.abort(new Error("route changed"));
        commitRequest.release();

        await assert.rejects(enrollment, SessionVaultOperationAbortedError);
        assert.deepEqual(await inspectSession(), { kind: "empty" });
    } finally {
        commitRequest.release();
        commitRequest.restore();
    }
});

test("cancelled migration preserves the retryable legacy record", async () => {
    const original = session("cancelled-migration");

    await putRaw(legacyPlaintext(original), 1);
    const candidate = legacy(await inspectSession());
    const controller = new AbortController();
    const derivation = delayNextRecoveryDerivation();

    try {
        const migration = migrateLegacySession(candidate, generateRecoveryKey(), undefined, {
            signal: controller.signal,
        });

        await derivation.reached;
        controller.abort(new Error("route changed"));
        derivation.release();

        await assert.rejects(migration, SessionVaultOperationAbortedError);
        assert.equal((await inspectSession()).kind, "legacy");
    } finally {
        derivation.release();
        derivation.restore();
    }
});

test("cancelled unlock disposes its decrypted lease before it can be published", async (t) => {
    const original = session("cancelled-unlock");

    await putRaw(legacyPlaintext(original), 1);
    const candidate = legacy(await inspectSession());
    const recoveryKey = generateRecoveryKey();
    const migrated = await migrateLegacySession(candidate, recoveryKey);

    migrated.dispose();
    await createNamedDatabase(candidate.legacySyncDatabase);
    const descriptor = locked(await inspectSession());
    const nativeDeleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    let releaseDeletion = (): void => undefined;
    let reportDeletionStarted = (): void => undefined;
    const deletionReleased = new Promise<void>((resolve) => {
        releaseDeletion = resolve;
    });
    const deletionStarted = new Promise<void>((resolve) => {
        reportDeletionStarted = resolve;
    });
    let delayed = false;
    let disposeCalls = 0;
    const originalDispose = SessionLease.prototype.dispose;

    t.mock.method(SessionLease.prototype, "dispose", function (this: SessionLease) {
        disposeCalls += 1;
        originalDispose.call(this);
    });
    Object.defineProperty(indexedDB, "deleteDatabase", {
        configurable: true,
        value: (name: string): IDBOpenDBRequest => {
            if (name !== candidate.legacySyncDatabase || delayed) {
                return nativeDeleteDatabase(name);
            }

            delayed = true;
            const delayedRequest = {} as IDBOpenDBRequest;

            reportDeletionStarted();
            void deletionReleased.then(() => {
                const request = nativeDeleteDatabase(name);

                request.onsuccess = (event) =>
                    delayedRequest.onsuccess?.call(delayedRequest, event);
                request.onerror = (event) => delayedRequest.onerror?.call(delayedRequest, event);
                request.onblocked = (event) =>
                    delayedRequest.onblocked?.call(delayedRequest, event);
            });

            return delayedRequest;
        },
    });
    const controller = new AbortController();

    try {
        const unlocking = unlockSession(
            descriptor,
            { kind: "recovery-key", recoveryKey },
            { signal: controller.signal },
        );

        await deletionStarted;
        controller.abort(new Error("route changed"));
        releaseDeletion();

        await assert.rejects(unlocking, SessionVaultOperationAbortedError);
        assert.equal(disposeCalls, 1);
        assert.equal((await inspectSession()).kind, "locked");
    } finally {
        releaseDeletion();
        Object.defineProperty(indexedDB, "deleteDatabase", {
            configurable: true,
            value: nativeDeleteDatabase,
        });
    }
});
