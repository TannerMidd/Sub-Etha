import assert from "node:assert/strict";
import test from "node:test";
import {
    createRemoteSessionWarningStore,
    REMOTE_LOGOUT_WARNING,
    REMOTE_PENDING_WARNING,
    REMOTE_REFRESH_WARNING,
} from "../lib/matrix/remote-session-warning";

class MemoryStorage {
    readonly values = new Map<string, string>();

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }
}

test("remote-session warnings survive a new application instance until acknowledgment", () => {
    const storage = new MemoryStorage();
    const firstDocument = createRemoteSessionWarningStore(() => storage);

    firstDocument.persist("logout");

    const reopenedDocument = createRemoteSessionWarningStore(() => storage);

    assert.equal(reopenedDocument.read(), REMOTE_LOGOUT_WARNING);
    reopenedDocument.clear();
    assert.equal(createRemoteSessionWarningStore(() => storage).read(), null);
});

test("a blocked storage write retains the warning in the current document", () => {
    const blocked = createRemoteSessionWarningStore(() => ({
        getItem: () => null,
        setItem: () => {
            throw new Error("Storage is blocked.");
        },
        removeItem: () => {
            throw new Error("Storage is blocked.");
        },
    }));

    blocked.persist("refresh");

    assert.equal(blocked.has("refresh"), true);
    assert.equal(blocked.read(), REMOTE_REFRESH_WARNING);
    blocked.clear();
    assert.equal(blocked.read(), null);
});

test("a refresh warning takes precedence over an ordinary logout warning", () => {
    const storage = new MemoryStorage();
    const warnings = createRemoteSessionWarningStore(() => storage);

    warnings.persist("logout");
    warnings.persist("refresh");

    assert.equal(warnings.read(), REMOTE_REFRESH_WARNING);
});

test("an abandoned pre-vault session warning survives reload", () => {
    const storage = new MemoryStorage();
    const firstDocument = createRemoteSessionWarningStore(() => storage);

    firstDocument.persist("pending");

    assert.equal(createRemoteSessionWarningStore(() => storage).read(), REMOTE_PENDING_WARNING);
});
