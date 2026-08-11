import {
    MatrixEvent,
    MemoryStore,
    SyncAccumulator,
    type IStateEventWithRoomId,
    type IStoredClientOpts,
    type ISyncResponse,
    type SyncUserProfile,
    type User,
} from "matrix-js-sdk";
import type { ISavedSync, IStore } from "matrix-js-sdk/lib/store";
import type {
    IndexedToDeviceBatch,
    ToDeviceBatchWithTxnId,
} from "matrix-js-sdk/lib/models/ToDeviceMessage";
import {
    decryptJson,
    encryptJson,
    opaqueRecordKey,
    requestValue,
    transactionDone,
    type DeviceKeys,
} from "./private-storage";
import type { DraftRepository, LocalStoreId, StorageMode } from "./types";

const ACCOUNT_DATABASE_PREFIX = "sub-etha-account-";
const DATABASE_VERSION = 1;
const RECORD_STORE = "records";
const SYNC_LIMIT_BYTES = 64 * 1024 * 1024;
const AUXILIARY_LIMIT_BYTES = 8 * 1024 * 1024;
const DRAFT_LIMIT_BYTES = 256 * 1024;
const SAVE_INTERVAL_MS = 5 * 60 * 1000;
const TIMELINE_LIMIT = 50;

function boundTimelineEntries(syncData: ISyncResponse): ISyncResponse {
    const bounded = structuredClone(syncData);

    for (const category of ["join", "leave"] as const) {
        for (const room of Object.values(bounded.rooms[category])) {
            if (room.timeline.events.length > TIMELINE_LIMIT) {
                room.timeline.events = room.timeline.events.slice(-TIMELINE_LIMIT);
            }
        }
    }

    return bounded;
}

type StoreEvent = Parameters<NonNullable<IStore["on"]>>[0];
type StoreHandler = Parameters<NonNullable<IStore["on"]>>[1];

export function accountDatabaseName(localStoreId: LocalStoreId): string {
    return ACCOUNT_DATABASE_PREFIX + localStoreId;
}

class EncryptedAccountDatabase {
    private database: IDBDatabase | null = null;
    private opened = false;
    private created = false;

    constructor(
        readonly name: string,
        private readonly keys: DeviceKeys,
        private readonly closed: () => void,
    ) {}

    async open(): Promise<void> {
        if (this.database) {
            return;
        }

        const request = indexedDB.open(this.name, DATABASE_VERSION);
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
            request.onupgradeneeded = () => {
                this.created = true;

                if (!request.result.objectStoreNames.contains(RECORD_STORE)) {
                    request.result.createObjectStore(RECORD_STORE);
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () =>
                reject(request.error ?? new Error("The encrypted account store could not open."));
            request.onblocked = () =>
                reject(new Error("Another tab is blocking the encrypted account store."));
        });

        database.onversionchange = () => {
            database.close();
            this.database = null;
            this.closed();
        };

        this.database = database;
        this.opened = true;
    }

    isNewlyCreated(): boolean {
        return this.opened && this.created;
    }

    private async opaqueKey(recordType: string, logicalId: string): Promise<string> {
        return opaqueRecordKey(this.keys.hmacKey, recordType + "\u001f" + logicalId);
    }

    private context(recordType: string, recordKey: string) {
        return {
            database: this.name,
            store: RECORD_STORE,
            recordType,
            recordKey,
        };
    }

    async read<T>(
        recordType: string,
        logicalId: string,
        maximumBytes = AUXILIARY_LIMIT_BYTES,
    ): Promise<T | null> {
        await this.open();
        const database = this.database;
        const recordKey = await this.opaqueKey(recordType, logicalId);

        if (!database) {
            throw new Error("The encrypted account store is closed.");
        }

        const transaction = database.transaction(RECORD_STORE, "readonly");
        const envelope = await requestValue(transaction.objectStore(RECORD_STORE).get(recordKey));

        await transactionDone(transaction);

        if (envelope === undefined) {
            return null;
        }

        return decryptJson<T>(
            this.keys.aesKey,
            envelope,
            this.context(recordType, recordKey),
            maximumBytes,
        );
    }

    async write(
        recordType: string,
        logicalId: string,
        value: unknown,
        maximumBytes = AUXILIARY_LIMIT_BYTES,
    ): Promise<void> {
        await this.open();
        const database = this.database;
        const recordKey = await this.opaqueKey(recordType, logicalId);

        if (!database) {
            throw new Error("The encrypted account store is closed.");
        }

        const envelope = await encryptJson(
            this.keys.aesKey,
            value,
            this.context(recordType, recordKey),
            maximumBytes,
        );
        const transaction = database.transaction(RECORD_STORE, "readwrite");

        transaction.objectStore(RECORD_STORE).put(envelope, recordKey);
        await transactionDone(transaction);
    }

    async remove(recordType: string, logicalId: string): Promise<void> {
        await this.open();
        const database = this.database;
        const recordKey = await this.opaqueKey(recordType, logicalId);

        if (!database) {
            return;
        }

        const transaction = database.transaction(RECORD_STORE, "readwrite");

        transaction.objectStore(RECORD_STORE).delete(recordKey);
        await transactionDone(transaction);
    }

    async clear(): Promise<void> {
        await this.open();

        if (!this.database) {
            return;
        }

        const transaction = this.database.transaction(RECORD_STORE, "readwrite");

        transaction.objectStore(RECORD_STORE).clear();
        await transactionDone(transaction);
    }

    close(): void {
        this.database?.close();
        this.database = null;
    }
}

export class MemoryDraftRepository implements DraftRepository {
    private readonly drafts = new Map<string, string>();

    async read(roomId: string): Promise<string | null> {
        return this.drafts.get(roomId) ?? null;
    }

    async write(roomId: string, value: string): Promise<void> {
        this.drafts.set(roomId, value);
    }

    async remove(roomId: string): Promise<void> {
        this.drafts.delete(roomId);
    }

    async flush(): Promise<void> {}

    async clear(): Promise<void> {
        this.drafts.clear();
    }
}

export class EncryptedDraftRepository implements DraftRepository {
    private readonly pending = new Map<string, string>();
    private readonly timers = new Map<string, number>();
    private index: Set<string> | null = null;

    private degraded = false;

    constructor(
        private readonly database: EncryptedAccountDatabase,
        private readonly onDegraded?: (error: unknown) => void,
    ) {}

    private handleFailure(error: unknown): boolean {
        if (!this.onDegraded) {
            return false;
        }

        this.degraded = true;
        this.onDegraded(error);

        return true;
    }

    private async readIndex(): Promise<Set<string>> {
        if (!this.index) {
            this.index = new Set((await this.database.read<string[]>("draft-index", "all")) ?? []);
        }

        return this.index;
    }

    async read(roomId: string): Promise<string | null> {
        if (this.pending.has(roomId)) {
            return this.pending.get(roomId) ?? null;
        }

        if (this.degraded) {
            return null;
        }

        try {
            return await this.database.read<string>("draft", roomId, DRAFT_LIMIT_BYTES);
        } catch (error) {
            if (!this.handleFailure(error)) {
                throw error;
            }

            return null;
        }
    }

    async write(roomId: string, value: string): Promise<void> {
        this.pending.set(roomId, value);

        if (new TextEncoder().encode(value).byteLength > DRAFT_LIMIT_BYTES) {
            const error = new RangeError("Drafts are limited to 256 KiB on disk.");

            if (!this.handleFailure(error)) {
                throw error;
            }

            return;
        }

        const current = this.timers.get(roomId);

        if (current !== undefined) {
            window.clearTimeout(current);
        }

        this.timers.set(
            roomId,
            window.setTimeout(() => {
                this.timers.delete(roomId);
                void this.persist(roomId).catch((error) => {
                    if (!this.handleFailure(error)) {
                        console.error("Encrypted draft persistence failed.", error);
                    }
                });
            }, 300),
        );
    }

    private async persist(roomId: string): Promise<void> {
        const value = this.pending.get(roomId);

        if (value === undefined) {
            return;
        }

        const index = await this.readIndex();

        await this.database.write("draft", roomId, value, DRAFT_LIMIT_BYTES);
        index.add(roomId);
        await this.database.write("draft-index", "all", [...index]);
    }

    async remove(roomId: string): Promise<void> {
        const timer = this.timers.get(roomId);

        this.pending.delete(roomId);

        if (timer !== undefined) {
            window.clearTimeout(timer);
            this.timers.delete(roomId);
        }

        if (this.degraded) {
            return;
        }

        try {
            await this.database.remove("draft", roomId);
            const index = await this.readIndex();

            index.delete(roomId);
            await this.database.write("draft-index", "all", [...index]);
        } catch (error) {
            if (!this.handleFailure(error)) {
                throw error;
            }
        }
    }

    async flush(): Promise<void> {
        for (const timer of this.timers.values()) {
            window.clearTimeout(timer);
        }

        this.timers.clear();

        try {
            await Promise.all([...this.pending.keys()].map((roomId) => this.persist(roomId)));
        } catch (error) {
            if (!this.handleFailure(error)) {
                throw error;
            }
        }
    }

    async clear(): Promise<void> {
        for (const timer of this.timers.values()) {
            window.clearTimeout(timer);
        }

        this.timers.clear();
        this.pending.clear();

        if (this.degraded) {
            return;
        }

        try {
            const index = await this.readIndex();

            await Promise.all([...index].map((roomId) => this.database.remove("draft", roomId)));
            index.clear();
            await this.database.remove("draft-index", "all");
        } catch (error) {
            if (!this.handleFailure(error)) {
                throw error;
            }
        }
    }
}

export class EncryptedMatrixStore extends MemoryStore {
    readonly drafts: DraftRepository;
    private database: EncryptedAccountDatabase;
    private accumulator = new SyncAccumulator({ maxTimelineEntries: TIMELINE_LIMIT });
    private handlers = new Map<StoreEvent, Set<StoreHandler>>();
    private lastSaved = 0;
    private hasSavedSync = false;
    private cachedClientOptions: IStoredClientOpts | undefined;
    private toDeviceBatches: IndexedToDeviceBatch[] = [];
    private nextEncryptedBatchId = 1;
    private degraded = false;

    constructor(localStoreId: LocalStoreId, keys: DeviceKeys) {
        super();
        this.database = new EncryptedAccountDatabase(accountDatabaseName(localStoreId), keys, () =>
            this.emitStoreEvent("closed"),
        );
        this.drafts = new EncryptedDraftRepository(this.database, (error) => this.degrade(error));
    }

    on(event: StoreEvent, handler: StoreHandler): void {
        let handlers = this.handlers.get(event);

        if (!handlers) {
            handlers = new Set();
            this.handlers.set(event, handlers);
        }

        handlers.add(handler);
    }

    private emitStoreEvent(event: StoreEvent, ...args: unknown[]): void {
        for (const handler of this.handlers.get(event) ?? []) {
            handler(...args);
        }
    }

    private degrade(error: unknown): void {
        if (!this.degraded) {
            this.degraded = true;
            this.emitStoreEvent("degraded", error);
        }
    }

    private async safeRead<T>(
        recordType: string,
        logicalId: string,
        maximumBytes = AUXILIARY_LIMIT_BYTES,
    ): Promise<T | null> {
        if (this.degraded) {
            return null;
        }

        try {
            return await this.database.read<T>(recordType, logicalId, maximumBytes);
        } catch (error) {
            this.degrade(error);
            await this.database.remove(recordType, logicalId).catch(() => undefined);

            return null;
        }
    }

    private async safeWrite(
        recordType: string,
        logicalId: string,
        value: unknown,
        maximumBytes = AUXILIARY_LIMIT_BYTES,
    ): Promise<void> {
        if (this.degraded) {
            return;
        }

        try {
            await this.database.write(recordType, logicalId, value, maximumBytes);
        } catch (error) {
            this.degrade(error);
        }
    }

    async startup(): Promise<void> {
        try {
            await this.database.open();
            const saved = await this.safeRead<ISavedSync>(
                "sync-snapshot",
                "current",
                SYNC_LIMIT_BYTES,
            );

            if (saved) {
                this.accumulator.accumulate(
                    {
                        next_batch: saved.nextBatch,
                        rooms: saved.roomsData,
                        account_data: { events: saved.accountData },
                    },
                    true,
                );
                this.hasSavedSync = true;
            }

            this.cachedClientOptions =
                (await this.safeRead<IStoredClientOpts>("client-options", "current")) ?? undefined;
            this.toDeviceBatches =
                (await this.safeRead<IndexedToDeviceBatch[]>("to-device-queue", "current")) ?? [];
            this.nextEncryptedBatchId =
                this.toDeviceBatches.reduce((highest, batch) => Math.max(highest, batch.id), 0) + 1;

            const presence =
                (await this.safeRead<Array<{ userId: string; event: object }>>(
                    "presence",
                    "current",
                )) ?? [];

            for (const entry of presence) {
                if (typeof entry.userId === "string" && entry.event && this.createUser) {
                    const user = this.createUser(entry.userId);

                    user.setPresenceEvent(new MatrixEvent(entry.event));
                    super.storeUser(user);
                }
            }
        } catch (error) {
            this.degrade(error);
        }
    }

    async isNewlyCreated(): Promise<boolean> {
        return this.database.isNewlyCreated();
    }

    async setSyncData(syncData: ISyncResponse): Promise<void> {
        this.accumulator.accumulate(boundTimelineEntries(syncData));
    }

    wantsSave(): boolean {
        return !this.degraded && Date.now() - this.lastSaved >= SAVE_INTERVAL_MS;
    }

    async save(force = false): Promise<void> {
        if (!force && !this.wantsSave()) {
            return;
        }

        await this.safeWrite(
            "sync-snapshot",
            "current",
            this.accumulator.getJSON(true),
            SYNC_LIMIT_BYTES,
        );
        this.lastSaved = Date.now();
        this.hasSavedSync = !this.degraded;
    }

    async getSavedSync(): Promise<ISavedSync | null> {
        return this.hasSavedSync ? this.accumulator.getJSON() : null;
    }

    async getSavedSyncToken(): Promise<string | null> {
        return this.hasSavedSync ? this.accumulator.getNextBatchToken() : null;
    }

    async deleteAllData(): Promise<void> {
        await super.deleteAllData();
        await this.database.clear();
        this.accumulator = new SyncAccumulator({ maxTimelineEntries: TIMELINE_LIMIT });
        this.toDeviceBatches = [];
        this.hasSavedSync = false;
    }

    async getOutOfBandMembers(roomId: string): Promise<IStateEventWithRoomId[] | null> {
        const inMemory = await super.getOutOfBandMembers(roomId);

        if (inMemory) {
            return inMemory;
        }

        const value = await this.safeRead<IStateEventWithRoomId[]>("oob-members", roomId);

        if (value) {
            await super.setOutOfBandMembers(roomId, value);
        }

        return value;
    }

    async setOutOfBandMembers(
        roomId: string,
        membershipEvents: IStateEventWithRoomId[],
    ): Promise<void> {
        await super.setOutOfBandMembers(roomId, membershipEvents);
        await this.safeWrite("oob-members", roomId, membershipEvents);
    }

    async clearOutOfBandMembers(roomId: string): Promise<void> {
        await super.clearOutOfBandMembers(roomId);
        await this.database.remove("oob-members", roomId).catch((error) => this.degrade(error));
    }

    async getClientOptions(): Promise<IStoredClientOpts | undefined> {
        return this.cachedClientOptions;
    }

    async storeClientOptions(options: IStoredClientOpts): Promise<void> {
        this.cachedClientOptions = structuredClone(options);
        await this.safeWrite("client-options", "current", this.cachedClientOptions);
    }

    async saveToDeviceBatches(batches: ToDeviceBatchWithTxnId[]): Promise<void> {
        for (const batch of batches) {
            this.toDeviceBatches.push({ ...batch, id: this.nextEncryptedBatchId++ });
        }

        await this.safeWrite("to-device-queue", "current", this.toDeviceBatches);
    }

    async getOldestToDeviceBatch(): Promise<IndexedToDeviceBatch | null> {
        return this.toDeviceBatches[0] ?? null;
    }

    async removeToDeviceBatch(id: number): Promise<void> {
        this.toDeviceBatches = this.toDeviceBatches.filter((batch) => batch.id !== id);
        await this.safeWrite("to-device-queue", "current", this.toDeviceBatches);
    }

    async getUserProfile(userId: string): Promise<SyncUserProfile | undefined> {
        const inMemory = await super.getUserProfile(userId);

        return (
            inMemory ?? (await this.safeRead<SyncUserProfile>("user-profile", userId)) ?? undefined
        );
    }

    async storeUserProfiles(userProfiles: Map<string, SyncUserProfile>): Promise<void> {
        await super.storeUserProfiles(userProfiles);
        await Promise.all(
            [...userProfiles].map(([userId, profile]) =>
                this.safeWrite("user-profile", userId, profile),
            ),
        );
    }

    async removeUserProfiles(userIds: string[]): Promise<void> {
        await super.removeUserProfiles(userIds);
        await Promise.all(
            userIds.map((userId) =>
                this.database.remove("user-profile", userId).catch((error) => this.degrade(error)),
            ),
        );
    }

    storeUser(user: User): void {
        super.storeUser(user);
        const presence = this.getUsers()
            .map((candidate) => {
                const event = candidate.events.presence;

                return event
                    ? { userId: candidate.userId, event: event.getEffectiveEvent() }
                    : null;
            })
            .filter((entry) => entry !== null);

        void this.safeWrite("presence", "current", presence);
    }

    async removeEventsFromRoom(roomId: string, eventIds: string[]): Promise<void> {
        this.accumulator.removeEventsFromRoom(roomId, eventIds);
        await this.save(true);
    }

    async destroy(): Promise<void> {
        await this.drafts.flush().catch(() => undefined);
        await this.save(true).catch(() => undefined);
        this.database.close();
    }
}

export async function migrateLegacyDrafts(
    localStoreId: LocalStoreId,
    keys: DeviceKeys,
): Promise<void> {
    const legacy: Array<{ key: string; roomId: string; value: string }> = [];

    for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);

        if (!key?.startsWith("sub-etha-draft:")) {
            continue;
        }

        const roomId = key.slice("sub-etha-draft:".length);
        const value = localStorage.getItem(key);

        if (!roomId || value === null) {
            throw new Error("A legacy draft record is invalid.");
        }

        if (new TextEncoder().encode(value).byteLength > DRAFT_LIMIT_BYTES) {
            throw new RangeError("A legacy draft exceeds the 256 KiB migration limit.");
        }

        legacy.push({ key, roomId, value });
    }

    if (legacy.length === 0) {
        return;
    }

    const database = new EncryptedAccountDatabase(
        accountDatabaseName(localStoreId),
        keys,
        () => undefined,
    );
    const drafts = new EncryptedDraftRepository(database);

    try {
        for (const entry of legacy) {
            await drafts.write(entry.roomId, entry.value);
        }

        await drafts.flush();
    } finally {
        database.close();
    }

    for (const entry of legacy) {
        localStorage.removeItem(entry.key);
    }
}

export function createDraftRepository(
    storageMode: StorageMode,
    store: EncryptedMatrixStore | null,
): DraftRepository {
    return storageMode === "remembered" && store ? store.drafts : new MemoryDraftRepository();
}
