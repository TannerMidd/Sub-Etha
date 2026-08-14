export type RemoteSessionWarningKind = "logout" | "pending" | "refresh";

interface WarningStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const WARNING_KEYS: Record<RemoteSessionWarningKind, string> = {
    logout: "sub-etha-remote-logout-warning-v1",
    pending: "sub-etha-remote-pending-warning-v1",
    refresh: "sub-etha-remote-refresh-warning-v1",
};

export const REMOTE_LOGOUT_WARNING =
    "Local sign-out finished, but the homeserver did not confirm that the remote Matrix session ended. Revoke this device from another trusted Matrix client before assuming it can no longer access the account.";

export const REMOTE_REFRESH_WARNING =
    "A refreshed Matrix session could not be saved, and the homeserver did not confirm revocation of the discarded credentials. This browser was locked; revoke this device from another trusted Matrix client before assuming those credentials are inactive.";
export const REMOTE_PENDING_WARNING =
    "Sign-in created a Matrix session, but this browser did not confirm its revocation before secure setup ended. Revoke this device from another trusted Matrix client before assuming that session is inactive.";

const warningMessage = (kind: RemoteSessionWarningKind) =>
    kind === "refresh"
        ? REMOTE_REFRESH_WARNING
        : kind === "pending"
          ? REMOTE_PENDING_WARNING
          : REMOTE_LOGOUT_WARNING;

export function createRemoteSessionWarningStore(resolveStorage: () => WarningStorage | null) {
    const memoryFallback = new Set<RemoteSessionWarningKind>();

    const has = (kind: RemoteSessionWarningKind): boolean => {
        if (memoryFallback.has(kind)) {
            return true;
        }

        try {
            return resolveStorage()?.getItem(WARNING_KEYS[kind]) === "1";
        } catch {
            return false;
        }
    };

    return {
        has,
        persist(kind: RemoteSessionWarningKind): void {
            try {
                const storage = resolveStorage();

                if (!storage) {
                    throw new Error("Durable browser storage is unavailable.");
                }

                storage.setItem(WARNING_KEYS[kind], "1");
                memoryFallback.delete(kind);
            } catch {
                // The warning must still survive rerouting within the current document even
                // when browser storage is blocked. Durable storage is retried on later events.
                memoryFallback.add(kind);
            }
        },
        read(): string | null {
            if (has("refresh")) {
                return warningMessage("refresh");
            }

            if (has("pending")) {
                return warningMessage("pending");
            }

            return has("logout") ? warningMessage("logout") : null;
        },
        clear(): void {
            memoryFallback.clear();

            try {
                const storage = resolveStorage();

                storage?.removeItem(WARNING_KEYS.logout);
                storage?.removeItem(WARNING_KEYS.pending);
                storage?.removeItem(WARNING_KEYS.refresh);
            } catch {
                // The in-memory warning is acknowledged; durable removal can be retried later.
            }
        },
    };
}

const browserWarnings = createRemoteSessionWarningStore(() => {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        return null;
    }
});

export const hasRemoteRefreshWarning = () => browserWarnings.has("refresh");
export const persistRemoteLogoutWarning = () => browserWarnings.persist("logout");
export const persistRemotePendingWarning = () => browserWarnings.persist("pending");
export const persistRemoteRefreshWarning = () => browserWarnings.persist("refresh");
export const readRemoteSessionWarning = () => browserWarnings.read();
export const clearRemoteSessionWarning = () => browserWarnings.clear();
