import type { ReadyWebAuthnPrfEnrollment, WebAuthnPrfSlotInput } from "../security/webauthn-prf";
import { evaluateWebAuthnPrf } from "../security/webauthn-prf";
import {
    createSealedRecord,
    decryptSessionPayload,
    encryptSessionPayload,
    randomBase64UrlBytes,
    unlockDekWithRecoveryKey,
    unlockDekWithWebAuthnPrf,
} from "../security/session-vault-crypto";
import {
    decodeCanonicalBase64Url,
    deepFreezeSession,
    exactStoredValueEqual,
    immutableSessionFieldsEqual,
    legacyStorageMetadata,
    normalizePersistedSession,
    SESSION_DATABASE,
    SESSION_DATABASE_VERSION,
    SESSION_KEY,
    SESSION_STORE,
    SessionVaultError,
    validateLockedRecord,
    validateTombstone,
    VAULT_SCHEMA_VERSION,
    type LockedMatrixSessionRecordV1,
    type MatrixSessionTombstoneV1,
    type UnlockSlotV1,
    type VaultStorageMetadata,
} from "../security/session-vault-format";
import type { PersistedMatrixSession } from "./types";

export { SessionVaultError } from "../security/session-vault-format";
export type { SessionVaultErrorCode } from "../security/session-vault-format";

export const SESSION_VAULT_LOCK_NAME = "sub-etha-session-vault-v1";

export interface LockedSessionDescriptor {
    kind: "locked";
    recordId: string;
    revision: number;
    cryptoDatabasePrefix: string;
    unlockSlots: Array<
        | { kind: "recovery-key"; slotId: string }
        | {
              kind: "webauthn-prf";
              slotId: string;
              credentialId: string;
              transports: AuthenticatorTransport[];
              rpId: string;
          }
    >;
}

export interface LegacySessionCandidate {
    kind: "legacy";
    session: Readonly<PersistedMatrixSession>;
    cryptoDatabasePrefix: string;
    legacySyncDatabase: string;
    /** Opaque exact structured-clone snapshot used only by migration CAS. */
    expectedRecord: unknown;
}

export interface SessionCleanupDescriptor {
    kind: "cleanup";
    recordId: string;
    revision: number;
    scope: "exact" | "all-owned";
    cryptoDatabasePrefix?: string;
    legacySyncDatabase?: string;
}

export interface SessionDeletionResult {
    cleanup: SessionCleanupDescriptor;
    session: Readonly<PersistedMatrixSession>;
}

export type VaultInspection =
    | { kind: "empty" }
    | LockedSessionDescriptor
    | LegacySessionCandidate
    | SessionCleanupDescriptor
    | { kind: "corrupt"; message: string };

export type SessionUnlock =
    | { kind: "recovery-key"; recoveryKey: string; slotId?: string }
    | { kind: "webauthn-prf"; slotId: string };

export interface SessionStoreOperationOptions {
    signal?: AbortSignal;
}

export class SessionVaultOperationAbortedError extends Error {
    constructor(reason?: unknown) {
        super("The sensitive session-vault operation was cancelled.", {
            cause: reason instanceof Error ? reason : undefined,
        });
        this.name = "SessionVaultOperationAbortedError";
    }
}

function assertOperationActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
        throw new SessionVaultOperationAbortedError(signal.reason);
    }
}

type TransactionAction<T> = (
    store: IDBObjectStore,
    transaction: IDBTransaction,
    resolveValue: (value: T) => void,
    rejectValue: (error: unknown) => void,
) => void;

function requireIndexedDb(): IDBFactory {
    if (typeof indexedDB === "undefined" || typeof indexedDB.open !== "function") {
        throw new SessionVaultError("unavailable", "Private browser storage is unavailable.");
    }

    return indexedDB;
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let request: IDBOpenDBRequest;

        try {
            request = requireIndexedDb().open(SESSION_DATABASE, SESSION_DATABASE_VERSION);
        } catch (error) {
            reject(
                new SessionVaultError(
                    "unavailable",
                    "Private browser storage could not be opened.",
                    {
                        cause: error,
                    },
                ),
            );

            return;
        }

        let settled = false;

        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(SESSION_STORE)) {
                request.result.createObjectStore(SESSION_STORE);
            }
        };

        request.onsuccess = () => {
            const database = request.result;

            database.onversionchange = () => database.close();

            if (settled) {
                database.close();

                return;
            }

            settled = true;
            resolve(database);
        };

        request.onerror = () => {
            if (!settled) {
                settled = true;
                reject(
                    new SessionVaultError(
                        "unavailable",
                        "Private browser storage could not be opened.",
                        { cause: request.error },
                    ),
                );
            }
        };

        request.onblocked = () => {
            if (!settled) {
                settled = true;
                reject(
                    new SessionVaultError(
                        "unavailable",
                        "Another app window is blocking the session-vault upgrade.",
                    ),
                );
            }
        };
    });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () =>
            reject(
                new SessionVaultError("unavailable", "Private session storage failed.", {
                    cause: request.error,
                }),
            );
    });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () =>
            reject(
                new SessionVaultError("conflict", "The session-vault transaction was aborted.", {
                    cause: transaction.error,
                }),
            );
        transaction.onerror = () =>
            reject(
                new SessionVaultError("unavailable", "The session-vault transaction failed.", {
                    cause: transaction.error,
                }),
            );
    });
}

async function readStoredRecord(): Promise<{ exists: boolean; value: unknown }> {
    const database = await openDatabase();

    try {
        const transaction = database.transaction(SESSION_STORE, "readonly");
        const completion = transactionDone(transaction);
        const cursor = await requestValue(
            transaction.objectStore(SESSION_STORE).openCursor(SESSION_KEY),
        );

        await completion;

        return cursor ? { exists: true, value: cursor.value } : { exists: false, value: undefined };
    } finally {
        database.close();
    }
}

async function transact<T>(
    action: TransactionAction<T>,
    options: SessionStoreOperationOptions = {},
): Promise<T> {
    assertOperationActive(options.signal);
    const database = await openDatabase();

    try {
        assertOperationActive(options.signal);
        const transaction = database.transaction(SESSION_STORE, "readwrite");
        const completion = transactionDone(transaction);
        let callbackError: unknown;
        let resolved = false;
        let value: T;

        const rejectValue = (error: unknown) => {
            if (callbackError) {
                return;
            }

            callbackError = error;

            try {
                transaction.abort();
            } catch {
                /* already inactive */
            }
        };

        const abortOperation = () => {
            rejectValue(new SessionVaultOperationAbortedError(options.signal?.reason));
        };

        options.signal?.addEventListener("abort", abortOperation, { once: true });

        try {
            assertOperationActive(options.signal);
            action(
                transaction.objectStore(SESSION_STORE),
                transaction,
                (next) => {
                    value = next;
                    resolved = true;
                },
                rejectValue,
            );
        } catch (error) {
            rejectValue(error);
        }

        try {
            await completion;
        } catch (error) {
            throw callbackError ?? error;
        } finally {
            options.signal?.removeEventListener("abort", abortOperation);
        }

        if (callbackError) {
            throw callbackError;
        }

        if (!resolved) {
            throw new SessionVaultError(
                "unavailable",
                "The session-vault transaction did not finish.",
            );
        }

        return value!;
    } finally {
        database.close();
    }
}

function descriptorFromRecord(record: LockedMatrixSessionRecordV1): LockedSessionDescriptor {
    return {
        kind: "locked",
        recordId: record.recordId,
        revision: record.revision,
        cryptoDatabasePrefix: record.storage.cryptoDatabasePrefix,
        unlockSlots: record.unlockSlots.map((slot) =>
            slot.kind === "recovery-key-pbkdf2"
                ? { kind: "recovery-key" as const, slotId: slot.slotId }
                : {
                      kind: "webauthn-prf" as const,
                      slotId: slot.slotId,
                      credentialId: slot.credentialId,
                      transports: [...slot.transports],
                      rpId: slot.rpId,
                  },
        ),
    };
}

function normalizeNewSession(value: PersistedMatrixSession): PersistedMatrixSession {
    return normalizePersistedSession(value, { requireCryptoDatabasePrefix: true });
}

function normalizeLegacyCandidate(value: unknown): LegacySessionCandidate {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SessionVaultError("corrupt", "The legacy Matrix session is invalid.");
    }

    const candidate = value as Record<string, unknown>;
    const userId = typeof candidate.userId === "string" ? candidate.userId : "";
    const deviceId = typeof candidate.deviceId === "string" ? candidate.deviceId : "";
    const storage = legacyStorageMetadata({ userId, deviceId });
    const session = normalizePersistedSession(value, {
        requireCryptoDatabasePrefix: false,
        derivedCryptoDatabasePrefix: storage.cryptoDatabasePrefix,
    });

    return {
        kind: "legacy",
        session: deepFreezeSession(session),
        cryptoDatabasePrefix: storage.cryptoDatabasePrefix,
        legacySyncDatabase: storage.legacySyncDatabase,
        expectedRecord: structuredClone(value),
    };
}

function isKnownKind(value: unknown, kind: string): boolean {
    return Boolean(
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).kind === kind,
    );
}

export async function inspectSession(): Promise<VaultInspection> {
    try {
        const stored = await readStoredRecord();

        if (!stored.exists) {
            return { kind: "empty" };
        }

        if (isKnownKind(stored.value, "locked-matrix-session")) {
            return descriptorFromRecord(validateLockedRecord(stored.value));
        }

        if (isKnownKind(stored.value, "matrix-session-tombstone")) {
            const tombstone = validateTombstone(stored.value);

            if (!tombstone.pendingCleanup) {
                return { kind: "empty" };
            }

            return {
                kind: "cleanup",
                recordId: tombstone.recordId,
                revision: tombstone.revision,
                scope: tombstone.pendingCleanup.scope,
                cryptoDatabasePrefix:
                    tombstone.pendingCleanup.scope === "exact"
                        ? tombstone.pendingCleanup.storage.cryptoDatabasePrefix
                        : undefined,
                legacySyncDatabase:
                    tombstone.pendingCleanup.scope === "exact"
                        ? tombstone.pendingCleanup.storage.legacySyncDatabase
                        : undefined,
            };
        }

        return normalizeLegacyCandidate(stored.value);
    } catch (error) {
        if (error instanceof SessionVaultError && error.code === "corrupt") {
            return { kind: "corrupt", message: error.message };
        }

        throw error;
    }
}

function recordMatchesDescriptor(
    record: LockedMatrixSessionRecordV1,
    descriptor: LockedSessionDescriptor,
): boolean {
    return (
        record.recordId === descriptor.recordId &&
        record.revision === descriptor.revision &&
        record.storage.cryptoDatabasePrefix === descriptor.cryptoDatabasePrefix
    );
}

async function readLockedRecord(
    descriptor: LockedSessionDescriptor,
): Promise<LockedMatrixSessionRecordV1> {
    const stored = await readStoredRecord();

    if (!stored.exists) {
        throw new SessionVaultError("conflict", "The locked Matrix session no longer exists.");
    }

    const record = validateLockedRecord(stored.value);

    if (!recordMatchesDescriptor(record, descriptor)) {
        throw new SessionVaultError("conflict", "The locked Matrix session changed before unlock.");
    }

    return record;
}

interface AvailableVaultStartingState {
    exists: boolean;
    expectedValue?: unknown;
}

async function readAvailableVaultStartingState(): Promise<AvailableVaultStartingState> {
    const stored = await readStoredRecord();

    if (!stored.exists) {
        return { exists: false };
    }

    try {
        const tombstone = validateTombstone(stored.value);

        if (tombstone.pendingCleanup) {
            throw new SessionVaultError(
                "conflict",
                "Local-session cleanup must finish before another login is stored.",
            );
        }
    } catch (error) {
        if (error instanceof SessionVaultError && error.code === "conflict") {
            throw error;
        }

        throw new SessionVaultError(
            "conflict",
            "A persisted Matrix session already occupies this vault.",
            { cause: error },
        );
    }

    return { exists: true, expectedValue: structuredClone(stored.value) };
}

async function commitNewRecord(
    startingState: AvailableVaultStartingState,
    record: LockedMatrixSessionRecordV1,
    options: SessionStoreOperationOptions,
): Promise<void> {
    await transact<void>((store, _transaction, resolve, reject) => {
        const request = store.openCursor(SESSION_KEY);

        request.onerror = () => reject(request.error ?? new Error("Session lookup failed."));

        request.onsuccess = () => {
            try {
                assertOperationActive(options.signal);
            } catch (error) {
                reject(error);

                return;
            }

            const stillMatchesStartingState = startingState.exists
                ? Boolean(
                      request.result &&
                      exactStoredValueEqual(request.result.value, startingState.expectedValue),
                  )
                : !request.result;

            if (!stillMatchesStartingState) {
                reject(
                    new SessionVaultError(
                        "conflict",
                        "The session vault changed while the new session was being encrypted.",
                    ),
                );

                return;
            }

            store.put(record, SESSION_KEY);
            resolve();
        };
    }, options);
}

async function commitMigratedRecord(
    candidate: LegacySessionCandidate,
    record: LockedMatrixSessionRecordV1,
    options: SessionStoreOperationOptions,
): Promise<void> {
    await transact<void>((store, _transaction, resolve, reject) => {
        const request = store.openCursor(SESSION_KEY);

        request.onerror = () => reject(request.error ?? new Error("Session lookup failed."));

        request.onsuccess = () => {
            try {
                assertOperationActive(options.signal);
            } catch (error) {
                reject(error);

                return;
            }

            if (
                !request.result ||
                !exactStoredValueEqual(request.result.value, candidate.expectedRecord)
            ) {
                reject(
                    new SessionVaultError(
                        "conflict",
                        "The legacy Matrix session changed before migration committed.",
                    ),
                );

                return;
            }

            store.put(record, SESSION_KEY);
            resolve();
        };
    }, options);
}

export async function createLockedSession(
    session: PersistedMatrixSession,
    recoveryKey: string,
    webAuthn?: ReadyWebAuthnPrfEnrollment,
    options: SessionStoreOperationOptions = {},
): Promise<SessionLease> {
    assertOperationActive(options.signal);
    const normalized = normalizeNewSession(session);

    return withAvailableVaultOwnership(async () => {
        assertOperationActive(options.signal);
        const startingState = await readAvailableVaultStartingState();

        assertOperationActive(options.signal);
        const storage: VaultStorageMetadata = {
            cryptoDatabasePrefix: normalized.cryptoDatabasePrefix,
        };
        const sealed = await createSealedRecord(normalized, storage, recoveryKey, webAuthn);

        assertOperationActive(options.signal);
        const record = validateLockedRecord(sealed.record);

        assertOperationActive(options.signal);
        await commitNewRecord(startingState, record, options);

        const lease = new SessionLease(SESSION_LEASE_AUTHORITY, record, normalized, sealed.dek);

        // Transaction completion is the linearization point. Once it wins the race with
        // cancellation, publish the matching lease synchronously so a committed credential
        // record is never left without an owner solely because the signal changed afterward.
        return lease;
    }, options.signal);
}

export async function migrateLegacySession(
    candidate: LegacySessionCandidate,
    recoveryKey: string,
    webAuthn?: ReadyWebAuthnPrfEnrollment,
    options: SessionStoreOperationOptions = {},
): Promise<SessionLease> {
    assertOperationActive(options.signal);

    if (candidate.kind !== "legacy") {
        throw new SessionVaultError("invalid-input", "A legacy session candidate is required.");
    }

    const inspected = normalizeLegacyCandidate(candidate.expectedRecord);
    const normalized = normalizePersistedSession(candidate.session, {
        requireCryptoDatabasePrefix: true,
    });

    if (
        candidate.cryptoDatabasePrefix !== inspected.cryptoDatabasePrefix ||
        candidate.legacySyncDatabase !== inspected.legacySyncDatabase ||
        !exactStoredValueEqual(normalized, inspected.session)
    ) {
        throw new SessionVaultError(
            "invalid-input",
            "The legacy session candidate does not match its inspected record.",
        );
    }

    return withAvailableVaultOwnership(async () => {
        assertOperationActive(options.signal);
        const stored = await readStoredRecord();

        assertOperationActive(options.signal);

        if (!stored.exists || !exactStoredValueEqual(stored.value, candidate.expectedRecord)) {
            throw new SessionVaultError(
                "conflict",
                "The legacy Matrix session changed before migration began.",
            );
        }

        const storage: VaultStorageMetadata = {
            cryptoDatabasePrefix: inspected.cryptoDatabasePrefix,
            legacySyncDatabase: inspected.legacySyncDatabase,
        };
        const sealed = await createSealedRecord(normalized, storage, recoveryKey, webAuthn);

        assertOperationActive(options.signal);
        const record = validateLockedRecord(sealed.record);

        // Keep plaintext migration retryable until the authenticated legacy cache
        // has been removed. A successful commit is therefore also the cleanup gate.
        assertOperationActive(options.signal);
        await deleteDatabaseStrict(inspected.legacySyncDatabase);

        assertOperationActive(options.signal);
        await commitMigratedRecord(candidate, record, options);

        const lease = new SessionLease(SESSION_LEASE_AUTHORITY, record, normalized, sealed.dek);

        return lease;
    }, options.signal);
}

export async function unlockSession(
    descriptor: LockedSessionDescriptor,
    unlock: SessionUnlock,
    options: SessionStoreOperationOptions = {},
): Promise<SessionLease> {
    assertOperationActive(options.signal);

    if (!descriptor || descriptor.kind !== "locked") {
        throw new SessionVaultError("invalid-input", "A locked session descriptor is required.");
    }

    return withAvailableVaultOwnership(async () => {
        assertOperationActive(options.signal);
        const record = await readLockedRecord(descriptor);

        assertOperationActive(options.signal);
        let dek: CryptoKey;

        if (unlock.kind === "recovery-key") {
            dek = await unlockDekWithRecoveryKey(record, unlock.recoveryKey, unlock.slotId);
        } else if (unlock.kind === "webauthn-prf") {
            dek = await unlockDekWithWebAuthnPrf(record, unlock.slotId, evaluateWebAuthnPrf);
        } else {
            throw new SessionVaultError("invalid-input", "The session unlock method is invalid.");
        }

        assertOperationActive(options.signal);
        const plaintext = await decryptSessionPayload(record, dek);

        assertOperationActive(options.signal);
        const session = normalizePersistedSession(plaintext, { requireCryptoDatabasePrefix: true });

        if (session.cryptoDatabasePrefix !== record.storage.cryptoDatabasePrefix) {
            throw new SessionVaultError(
                "authentication",
                "The encrypted session and authenticated storage identity disagree.",
            );
        }

        const lease = new SessionLease(SESSION_LEASE_AUTHORITY, record, session, dek);

        try {
            assertOperationActive(options.signal);
            await deleteAuthenticatedLegacySyncDatabase(lease);

            assertOperationActive(options.signal);

            return lease;
        } catch (error) {
            lease.dispose();

            throw error;
        }
    }, options.signal);
}

async function commitReseal(
    expected: LockedMatrixSessionRecordV1,
    next: LockedMatrixSessionRecordV1,
): Promise<void> {
    await transact<void>((store, _transaction, resolve, reject) => {
        const request = store.openCursor(SESSION_KEY);

        request.onerror = () => reject(request.error ?? new Error("Session lookup failed."));

        request.onsuccess = () => {
            let current: LockedMatrixSessionRecordV1;

            try {
                if (!request.result) {
                    throw new SessionVaultError(
                        "conflict",
                        "The locked Matrix session was removed before reseal.",
                    );
                }

                current = validateLockedRecord(request.result.value);
            } catch (error) {
                reject(error);

                return;
            }

            if (current.recordId !== expected.recordId || current.revision !== expected.revision) {
                reject(
                    new SessionVaultError(
                        "conflict",
                        "A stale session lease cannot overwrite a newer vault revision.",
                    ),
                );

                return;
            }

            store.put(next, SESSION_KEY);
            resolve();
        };
    });
}

async function commitTombstone(
    record: LockedMatrixSessionRecordV1,
): Promise<SessionCleanupDescriptor> {
    const tombstone: MatrixSessionTombstoneV1 = {
        kind: "matrix-session-tombstone",
        schemaVersion: VAULT_SCHEMA_VERSION,
        recordId: record.recordId,
        revision: record.revision + 1,
        pendingCleanup: { scope: "exact", storage: { ...record.storage } },
    };

    await transact<void>((store, _transaction, resolve, reject) => {
        const request = store.openCursor(SESSION_KEY);

        request.onerror = () => reject(request.error ?? new Error("Session lookup failed."));

        request.onsuccess = () => {
            let current: LockedMatrixSessionRecordV1;

            try {
                if (!request.result) {
                    throw new SessionVaultError(
                        "conflict",
                        "The locked Matrix session was already removed.",
                    );
                }

                current = validateLockedRecord(request.result.value);
            } catch (error) {
                reject(error);

                return;
            }

            if (current.recordId !== record.recordId || current.revision !== record.revision) {
                reject(
                    new SessionVaultError(
                        "conflict",
                        "A stale session lease cannot delete a newer vault revision.",
                    ),
                );

                return;
            }

            store.put(tombstone, SESSION_KEY);
            resolve();
        };
    });

    return {
        kind: "cleanup",
        recordId: tombstone.recordId,
        revision: tombstone.revision,
        scope: "exact",
        cryptoDatabasePrefix: record.storage.cryptoDatabasePrefix,
        legacySyncDatabase: record.storage.legacySyncDatabase,
    };
}

const SESSION_LEASE_AUTHORITY: unique symbol = Symbol("authenticated-session-lease");

export class SessionLease {
    #record: LockedMatrixSessionRecordV1;
    #session: Readonly<PersistedMatrixSession>;
    #dek: CryptoKey | null;
    #serialized: Promise<void> = Promise.resolve();

    constructor(
        authority: typeof SESSION_LEASE_AUTHORITY,
        record: LockedMatrixSessionRecordV1,
        session: PersistedMatrixSession,
        dek: CryptoKey,
    ) {
        if (authority !== SESSION_LEASE_AUTHORITY) {
            throw new SessionVaultError(
                "invalid-input",
                "Session leases can only be created from an authenticated vault record.",
            );
        }

        this.#record = structuredClone(record);
        this.#session = deepFreezeSession(session);
        this.#dek = dek;
    }

    #assertActive(): CryptoKey {
        if (!this.#dek) {
            throw new SessionVaultError("disposed", "This session lease has been disposed.");
        }

        return this.#dek;
    }

    get session(): Readonly<PersistedMatrixSession> {
        this.#assertActive();

        return this.#session;
    }

    get recordId(): string {
        this.#assertActive();

        return this.#record.recordId;
    }

    get revision(): number {
        this.#assertActive();

        return this.#record.revision;
    }

    get cryptoDatabasePrefix(): string {
        this.#assertActive();

        return this.#record.storage.cryptoDatabasePrefix;
    }

    authenticatedStorage(authority: typeof SESSION_LEASE_AUTHORITY): VaultStorageMetadata {
        if (authority !== SESSION_LEASE_AUTHORITY) {
            throw new SessionVaultError(
                "invalid-input",
                "Authenticated storage authority is required.",
            );
        }

        this.#assertActive();

        return { ...this.#record.storage };
    }

    assertCurrent(): Promise<void> {
        try {
            this.#assertActive();
        } catch (error) {
            return Promise.reject(error);
        }

        const operation = this.#serialized.then(async () => {
            this.#assertActive();
            const stored = await readStoredRecord();

            this.#assertActive();

            if (!stored.exists) {
                throw new SessionVaultError(
                    "conflict",
                    "The unlocked Matrix session no longer exists.",
                );
            }

            let current: LockedMatrixSessionRecordV1;

            try {
                current = validateLockedRecord(stored.value);
            } catch (error) {
                throw new SessionVaultError(
                    "conflict",
                    "The unlocked Matrix session is no longer current.",
                    { cause: error },
                );
            }

            if (!exactStoredValueEqual(current, this.#record)) {
                throw new SessionVaultError(
                    "conflict",
                    "The unlocked Matrix session is no longer current.",
                );
            }
        });

        this.#serialized = operation.catch(() => undefined);

        return operation;
    }

    reseal(nextSession: PersistedMatrixSession, reason: "token-refresh"): Promise<void> {
        try {
            this.#assertActive();
        } catch (error) {
            return Promise.reject(error);
        }

        const operation = this.#serialized.then(async () => {
            const dek = this.#assertActive();

            if (reason !== "token-refresh") {
                throw new SessionVaultError(
                    "invalid-input",
                    "The session reseal reason is invalid.",
                );
            }

            const normalized = normalizeNewSession(nextSession);

            if (!immutableSessionFieldsEqual(this.#session as PersistedMatrixSession, normalized)) {
                throw new SessionVaultError(
                    "invalid-input",
                    "A session reseal cannot change immutable account or crypto identity.",
                );
            }

            const expected = this.#record;
            const revision = expected.revision + 1;
            const payload = await encryptSessionPayload(expected, revision, normalized, dek);
            const nextRecord: LockedMatrixSessionRecordV1 = {
                ...expected,
                revision,
                payload,
            };

            this.#assertActive();
            await commitReseal(expected, nextRecord);

            // Disposal can race the IndexedDB commit. A successful commit remains the
            // authoritative vault session, but a disposed lease must never regain in-memory
            // plaintext or its key. Resolve successfully so lifecycle callers distinguish this
            // case from a pre-commit failure whose discarded tokens must be revoked.
            if (!this.#dek) {
                return;
            }

            this.#record = nextRecord;
            this.#session = deepFreezeSession(normalized);
        });

        this.#serialized = operation.catch(() => undefined);

        return operation;
    }

    async deleteRecord(): Promise<SessionDeletionResult> {
        this.#assertActive();
        const operation = this.#serialized.then(async () => {
            this.#assertActive();
            const session = this.#session;
            const cleanup = await commitTombstone(this.#record);

            this.dispose();

            return { cleanup, session };
        });

        this.#serialized = operation.then(
            () => undefined,
            () => undefined,
        );

        return operation;
    }

    dispose(): void {
        this.#dek = null;
        this.#session = Object.freeze({}) as Readonly<PersistedMatrixSession>;
    }
}

export async function deleteSessionRecord(lease: SessionLease): Promise<SessionDeletionResult> {
    if (!(lease instanceof SessionLease)) {
        throw new SessionVaultError("invalid-input", "An active session lease is required.");
    }

    return lease.deleteRecord();
}

async function withAvailableVaultOwnership<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    assertOperationActive(signal);

    if (
        typeof navigator === "undefined" ||
        !("locks" in navigator) ||
        typeof navigator.locks?.request !== "function"
    ) {
        throw new SessionVaultError(
            "unavailable",
            "This browser cannot safely modify the local Matrix session.",
        );
    }

    try {
        return await navigator.locks.request(
            SESSION_VAULT_LOCK_NAME,
            { ifAvailable: true },
            async (lock) => {
                assertOperationActive(signal);

                if (!lock) {
                    throw new SessionVaultError(
                        "conflict",
                        "Another Sub-Etha window currently owns the local Matrix session.",
                    );
                }

                return operation();
            },
        );
    } catch (error) {
        if (
            error instanceof SessionVaultError ||
            error instanceof SessionVaultOperationAbortedError
        ) {
            throw error;
        }

        throw new SessionVaultError(
            "unavailable",
            "Safe ownership of the local Matrix session could not be acquired.",
            { cause: error },
        );
    }
}

export async function forgetLocalSession(): Promise<SessionCleanupDescriptor> {
    return withAvailableVaultOwnership(() =>
        transact<SessionCleanupDescriptor>((store, _transaction, resolve, reject) => {
            const request = store.openCursor(SESSION_KEY);

            request.onerror = () => reject(request.error ?? new Error("Session lookup failed."));

            request.onsuccess = () => {
                let recordId = randomBase64UrlBytes(16);
                let revision = 1;
                let pendingCleanup: MatrixSessionTombstoneV1["pendingCleanup"] = {
                    scope: "all-owned",
                };

                try {
                    if (request.result) {
                        if (isKnownKind(request.result.value, "locked-matrix-session")) {
                            const locked = validateLockedRecord(request.result.value);

                            recordId = locked.recordId;
                            revision = locked.revision + 1;
                            // The user authorized a full local reset, but a locked record's outer
                            // target metadata is not authenticated. Delete only databases whose
                            // canonical names prove that they are Sub-Etha Matrix storage.
                            pendingCleanup = { scope: "all-owned" };
                        } else if (isKnownKind(request.result.value, "matrix-session-tombstone")) {
                            const existing = validateTombstone(request.result.value);

                            recordId = existing.recordId;
                            revision = existing.revision + 1;
                            pendingCleanup = existing.pendingCleanup
                                ? structuredClone(existing.pendingCleanup)
                                : { scope: "all-owned" };
                        } else {
                            const legacy = normalizeLegacyCandidate(request.result.value);

                            pendingCleanup = {
                                scope: "exact",
                                storage: {
                                    cryptoDatabasePrefix: legacy.cryptoDatabasePrefix,
                                    legacySyncDatabase: legacy.legacySyncDatabase,
                                },
                            };
                        }
                    }
                } catch {
                    // A corrupt record has no trustworthy exact database identity. The user's
                    // reset still authorizes deleting every canonical Sub-Etha Matrix database.
                    pendingCleanup = { scope: "all-owned" };
                }

                const tombstone: MatrixSessionTombstoneV1 = {
                    kind: "matrix-session-tombstone",
                    schemaVersion: VAULT_SCHEMA_VERSION,
                    recordId,
                    revision,
                    pendingCleanup,
                };

                store.put(tombstone, SESSION_KEY);
                resolve({
                    kind: "cleanup",
                    recordId: tombstone.recordId,
                    revision: tombstone.revision,
                    scope: tombstone.pendingCleanup!.scope,
                    cryptoDatabasePrefix:
                        tombstone.pendingCleanup?.scope === "exact"
                            ? tombstone.pendingCleanup.storage.cryptoDatabasePrefix
                            : undefined,
                    legacySyncDatabase:
                        tombstone.pendingCleanup?.scope === "exact"
                            ? tombstone.pendingCleanup.storage.legacySyncDatabase
                            : undefined,
                });
            };
        }),
    );
}

function cleanupScopeMatchesDescriptor(
    pendingCleanup: MatrixSessionTombstoneV1["pendingCleanup"],
    descriptor: SessionCleanupDescriptor,
): boolean {
    if (!pendingCleanup || pendingCleanup.scope !== descriptor.scope) {
        return false;
    }

    if (pendingCleanup.scope === "all-owned") {
        return (
            descriptor.cryptoDatabasePrefix === undefined &&
            descriptor.legacySyncDatabase === undefined
        );
    }

    return (
        pendingCleanup.storage.cryptoDatabasePrefix === descriptor.cryptoDatabasePrefix &&
        pendingCleanup.storage.legacySyncDatabase === descriptor.legacySyncDatabase
    );
}

export async function completeLocalSessionCleanup(
    descriptor: SessionCleanupDescriptor,
): Promise<void> {
    if (!descriptor || descriptor.kind !== "cleanup") {
        throw new SessionVaultError("invalid-input", "A cleanup descriptor is required.");
    }

    await transact<void>((store, _transaction, resolve, reject) => {
        const request = store.openCursor(SESSION_KEY);

        request.onerror = () => reject(request.error ?? new Error("Session lookup failed."));

        request.onsuccess = () => {
            let current: MatrixSessionTombstoneV1;

            try {
                if (!request.result) {
                    throw new SessionVaultError("conflict", "The cleanup marker no longer exists.");
                }

                current = validateTombstone(request.result.value);
            } catch (error) {
                reject(error);

                return;
            }

            if (
                current.recordId !== descriptor.recordId ||
                current.revision !== descriptor.revision ||
                !cleanupScopeMatchesDescriptor(current.pendingCleanup, descriptor)
            ) {
                reject(
                    new SessionVaultError(
                        "conflict",
                        "The local-session cleanup marker changed before completion.",
                    ),
                );

                return;
            }

            store.put(
                {
                    kind: "matrix-session-tombstone",
                    schemaVersion: VAULT_SCHEMA_VERSION,
                    recordId: current.recordId,
                    revision: current.revision + 1,
                } satisfies MatrixSessionTombstoneV1,
                SESSION_KEY,
            );
            resolve();
        };
    });
}

export function generateRecoveryKey(): string {
    return randomBase64UrlBytes(32);
}

export function randomBase64Url(byteLength = 32): string {
    if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > 65_536) {
        throw new SessionVaultError("invalid-input", "The random-byte length is invalid.");
    }

    return randomBase64UrlBytes(byteLength);
}

export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
    return decodeCanonicalBase64Url(value, "Base64URL value", { maximumBytes: 65_536 });
}

type NewSessionInput = Omit<PersistedMatrixSession, "cryptoStorageKey" | "cryptoDatabasePrefix">;

export function createSession(input: NewSessionInput): PersistedMatrixSession {
    return {
        ...input,
        cryptoStorageKey: randomBase64Url(32),
        cryptoDatabasePrefix: `sub-etha-crypto-${randomBase64Url(16)}`,
    };
}

async function deleteAuthenticatedLegacySyncDatabase(lease: SessionLease): Promise<void> {
    if (!(lease instanceof SessionLease)) {
        throw new SessionVaultError("invalid-input", "An authenticated session lease is required.");
    }

    await lease.assertCurrent();
    const storage = lease.authenticatedStorage(SESSION_LEASE_AUTHORITY);

    if (!storage.legacySyncDatabase) {
        return;
    }

    await deleteDatabaseStrict(storage.legacySyncDatabase);
}

function deleteDatabaseStrict(name: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let request: IDBOpenDBRequest;

        try {
            request = requireIndexedDb().deleteDatabase(name);
        } catch (error) {
            reject(
                new SessionVaultError(
                    "unavailable",
                    `The local database ${name} could not be removed.`,
                    {
                        cause: error,
                    },
                ),
            );

            return;
        }

        let settled = false;

        const finish = () => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                resolve();
            }
        };

        const fail = (message: string, cause?: unknown) => {
            if (!settled) {
                settled = true;
                clearTimeout(timeout);
                reject(new SessionVaultError("unavailable", message, { cause }));
            }
        };

        const timeout = setTimeout(
            () => fail(`Timed out removing the local database ${name}.`),
            5_000,
        );

        request.onsuccess = finish;
        request.onerror = () =>
            fail(`The local database ${name} could not be removed.`, request.error);
        request.onblocked = () =>
            fail(`Another app window is blocking removal of the local database ${name}.`);
    });
}

export async function cleanupSessionDatabases(descriptor: SessionCleanupDescriptor): Promise<void> {
    assertCleanupDescriptor(descriptor);

    // Crash-resumed cleanup never inherits ownership from the Matrix runtime. Keep marker
    // validation and every database deletion inside the fixed origin-wide lock so an old
    // cleaner cannot race a completed marker and a newly enrolled session.
    return withAvailableVaultOwnership(() => cleanupSessionDatabasesWithOwnership(descriptor));
}

/**
 * Deletes an exact session's databases when the caller already holds SESSION_VAULT_LOCK_NAME.
 * MatrixService uses this non-reentrant path while its authenticated runtime owns the vault.
 */
export async function cleanupExactSessionDatabasesWhileHoldingVaultLock(
    descriptor: SessionCleanupDescriptor,
): Promise<void> {
    assertCleanupDescriptor(descriptor);

    if (descriptor.scope !== "exact") {
        throw new SessionVaultError(
            "invalid-input",
            "Held-lock cleanup is limited to an authenticated exact session.",
        );
    }

    return cleanupSessionDatabasesWithOwnership(descriptor);
}

function assertCleanupDescriptor(
    descriptor: SessionCleanupDescriptor,
): asserts descriptor is SessionCleanupDescriptor {
    if (!descriptor || descriptor.kind !== "cleanup") {
        throw new SessionVaultError("invalid-input", "A cleanup descriptor is required.");
    }
}

async function cleanupSessionDatabasesWithOwnership(
    descriptor: SessionCleanupDescriptor,
): Promise<void> {
    const stored = await readStoredRecord();

    if (!stored.exists) {
        throw new SessionVaultError("conflict", "The cleanup marker no longer exists.");
    }

    const tombstone = validateTombstone(stored.value);

    if (
        tombstone.recordId !== descriptor.recordId ||
        tombstone.revision !== descriptor.revision ||
        !cleanupScopeMatchesDescriptor(tombstone.pendingCleanup, descriptor)
    ) {
        throw new SessionVaultError(
            "conflict",
            "The local-session cleanup marker changed before database cleanup.",
        );
    }

    const pendingCleanup = tombstone.pendingCleanup;

    if (!pendingCleanup) {
        throw new SessionVaultError("corrupt", "The cleanup marker has no pending cleanup scope.");
    }

    // A crash-reloaded tombstone has no independent cryptographic anchor. Exact targets are
    // therefore accepted only inside the strictly validated Sub-Etha Matrix namespaces; an
    // origin-compromised writer already has direct IndexedDB deletion authority. User-confirmed
    // locked/corrupt resets carry no target at all and use the bounded all-owned scope instead.
    const names =
        pendingCleanup.scope === "all-owned"
            ? await enumerateOwnedMatrixDatabases()
            : [
                  pendingCleanup.storage.legacySyncDatabase,
                  `${pendingCleanup.storage.cryptoDatabasePrefix}::matrix-sdk-crypto`,
                  `${pendingCleanup.storage.cryptoDatabasePrefix}::matrix-sdk-crypto-meta`,
              ].filter((name): name is string => Boolean(name));

    const results = await Promise.allSettled(names.map(deleteDatabaseStrict));
    const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);

    if (failures.length > 0) {
        throw new SessionVaultError(
            "unavailable",
            "One or more local session databases could not be removed.",
            { cause: new AggregateError(failures) },
        );
    }
}

const OWNED_LEGACY_SYNC_DATABASE = /^matrix-js-sdk:sub-etha-sync-[A-Za-z0-9_-]{1,120}$/;
const OWNED_RUST_CRYPTO_DATABASE =
    /^sub-etha-crypto-[A-Za-z0-9_-]{1,160}::matrix-sdk-crypto(?:-meta)?$/;

async function enumerateOwnedMatrixDatabases(): Promise<string[]> {
    const factory = requireIndexedDb();

    if (typeof factory.databases !== "function") {
        throw new SessionVaultError(
            "unavailable",
            "This browser cannot enumerate Sub-Etha databases for a safe reset. Clear this site's data in browser settings.",
        );
    }

    let databases: IDBDatabaseInfo[];

    try {
        databases = await factory.databases();
    } catch (error) {
        throw new SessionVaultError(
            "unavailable",
            "Sub-Etha databases could not be enumerated for reset. Clear this site's data in browser settings.",
            { cause: error },
        );
    }

    return databases
        .map(({ name }) => name)
        .filter(
            (name): name is string =>
                typeof name === "string" &&
                (OWNED_LEGACY_SYNC_DATABASE.test(name) || OWNED_RUST_CRYPTO_DATABASE.test(name)),
        );
}

export type { WebAuthnPrfSlotInput, UnlockSlotV1 };
