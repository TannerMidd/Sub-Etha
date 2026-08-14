const DRAFT_KEY_PREFIX = "sub-etha-draft:";

const drafts = new Map<string, string>();

function draftKey(roomId: string): string {
    return `${DRAFT_KEY_PREFIX}${roomId}`;
}

export function readMemoryDraft(roomId: string): string {
    return drafts.get(roomId) ?? "";
}

export function writeMemoryDraft(roomId: string, body: string): void {
    if (body) {
        drafts.set(roomId, body);
    } else {
        drafts.delete(roomId);
    }
}

export function removeMemoryDraft(roomId: string): void {
    drafts.delete(roomId);
}

export function clearMemoryDrafts(): void {
    drafts.clear();
}

export function clearLegacyPersistedDrafts(storage?: Storage): void {
    let target = storage;

    if (!target) {
        try {
            target = globalThis.localStorage;
        } catch {
            return;
        }
    }

    if (!target) {
        return;
    }

    const keys: string[] = [];

    for (let index = 0; index < target.length; index += 1) {
        const key = target.key(index);

        if (key?.startsWith(DRAFT_KEY_PREFIX)) {
            keys.push(key);
        }
    }

    for (const key of keys) {
        target.removeItem(key);
    }
}

export function legacyDraftStorageKey(roomId: string): string {
    return draftKey(roomId);
}
