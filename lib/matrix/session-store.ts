import type { PersistedMatrixSession } from "./types";

const DATABASE = "sub-etha-session";
const STORE = "private";
const SESSION_KEY = "matrix-session";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open private session storage."));
  });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = run(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Private session storage failed."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error ?? new Error("Private session transaction failed."));
  });
}

export async function readSession(): Promise<PersistedMatrixSession | null> {
  return (await transact("readonly", (store) => store.get(SESSION_KEY))) ?? null;
}

export async function saveSession(session: PersistedMatrixSession): Promise<void> {
  await transact("readwrite", (store) => store.put(session, SESSION_KEY));
}

export async function clearSession(): Promise<void> {
  await transact("readwrite", (store) => store.delete(SESSION_KEY));
}

export function randomBase64Url(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function createSession(input: Omit<PersistedMatrixSession, "cryptoStorageKey">): PersistedMatrixSession {
  return { ...input, cryptoStorageKey: randomBase64Url(32) };
}
