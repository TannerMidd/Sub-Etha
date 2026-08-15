import assert from "node:assert/strict";
import test from "node:test";
import {
    clearLegacyPersistedDrafts,
    clearMemoryDrafts,
    legacyDraftStorageKey,
    readMemoryDraft,
    removeMemoryDraft,
    writeMemoryDraft,
} from "../lib/matrix/drafts";

class MemoryStorage implements Storage {
    private readonly values = new Map<string, string>();

    get length(): number {
        return this.values.size;
    }

    clear(): void {
        this.values.clear();
    }

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    key(index: number): string | null {
        return [...this.values.keys()][index] ?? null;
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
}

test("drafts remain in document memory and can be cleared as a group", () => {
    clearMemoryDrafts();
    writeMemoryDraft("!one:example", "first");
    writeMemoryDraft("!two:example", "second");

    assert.equal(readMemoryDraft("!one:example"), "first");
    removeMemoryDraft("!one:example");
    assert.equal(readMemoryDraft("!one:example"), "");
    assert.equal(readMemoryDraft("!two:example"), "second");

    clearMemoryDrafts();
    assert.equal(readMemoryDraft("!two:example"), "");
});

test("empty draft writes remove the in-memory value", () => {
    clearMemoryDrafts();
    writeMemoryDraft("!room:example", "draft");
    writeMemoryDraft("!room:example", "");

    assert.equal(readMemoryDraft("!room:example"), "");
});

test("startup cleanup removes only historical Sub-Etha draft keys", () => {
    const storage = new MemoryStorage();

    storage.setItem(legacyDraftStorageKey("!one:example"), "secret one");
    storage.setItem(legacyDraftStorageKey("!two:example"), "secret two");
    storage.setItem("sub-etha-theme", "dark");
    storage.setItem("unrelated", "preserve");

    clearLegacyPersistedDrafts(storage);

    assert.equal(storage.getItem(legacyDraftStorageKey("!one:example")), null);
    assert.equal(storage.getItem(legacyDraftStorageKey("!two:example")), null);
    assert.equal(storage.getItem("sub-etha-theme"), "dark");
    assert.equal(storage.getItem("unrelated"), "preserve");
});
