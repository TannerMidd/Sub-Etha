import type { ReadyWebAuthnPrfEnrollment, WebAuthnPrfSlotInput } from "./webauthn-prf";
import type { PersistedMatrixSession } from "../matrix/types";
import {
    decodeCanonicalBase64Url,
    encodeBase64Url,
    MAX_PAYLOAD_BYTES,
    MAX_RECOVERY_INPUT_BYTES,
    payloadAdditionalData,
    RECOVERY_ITERATIONS,
    SessionVaultError,
    slotAdditionalData,
    VAULT_SCHEMA_VERSION,
    webAuthnHkdfInfo,
    type AesGcmBox,
    type LockedMatrixSessionRecordV1,
    type RecoveryKeySlotV1,
    type UnlockSlotV1,
    type VaultStorageMetadata,
    type WebAuthnPrfSlotV1,
} from "./session-vault-format";

const DEK_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 32;

function requireWebCrypto(): SubtleCrypto {
    if (
        typeof crypto === "undefined" ||
        typeof crypto.getRandomValues !== "function" ||
        !crypto.subtle
    ) {
        throw new SessionVaultError("unavailable", "Secure browser cryptography is unavailable.");
    }

    return crypto.subtle;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
    requireWebCrypto();

    return crypto.getRandomValues(new Uint8Array(length));
}

export function randomBase64UrlBytes(length: number): string {
    const bytes = randomBytes(length);

    try {
        return encodeBase64Url(bytes);
    } finally {
        bytes.fill(0);
    }
}

async function importAesKey(raw: Uint8Array<ArrayBuffer>, usages: KeyUsage[]): Promise<CryptoKey> {
    return requireWebCrypto().importKey("raw", raw, "AES-GCM", false, usages);
}

async function aesEncrypt(
    key: CryptoKey,
    plaintext: Uint8Array<ArrayBuffer>,
    additionalData: Uint8Array<ArrayBuffer>,
): Promise<AesGcmBox> {
    const iv = randomBytes(IV_BYTES);
    const ownedAdditionalData = new Uint8Array(additionalData);

    try {
        const ciphertext = await requireWebCrypto().encrypt(
            {
                name: "AES-GCM",
                iv,
                additionalData: ownedAdditionalData,
                tagLength: 128,
            },
            key,
            plaintext,
        );

        return {
            algorithm: "AES-256-GCM",
            iv: encodeBase64Url(iv),
            ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
        };
    } finally {
        iv.fill(0);
        ownedAdditionalData.fill(0);
    }
}

async function aesDecrypt(
    key: CryptoKey,
    box: AesGcmBox,
    additionalData: Uint8Array<ArrayBuffer>,
    maximumPlaintextBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
    const iv = decodeCanonicalBase64Url(box.iv, "AES-GCM IV", {
        exactBytes: IV_BYTES,
        maximumBytes: IV_BYTES,
    });
    const ciphertext = decodeCanonicalBase64Url(box.ciphertext, "AES-GCM ciphertext", {
        minimumBytes: 16,
        maximumBytes: maximumPlaintextBytes + 16,
    });
    const ownedAdditionalData = new Uint8Array(additionalData);

    try {
        const plaintext = await requireWebCrypto().decrypt(
            {
                name: "AES-GCM",
                iv,
                additionalData: ownedAdditionalData,
                tagLength: 128,
            },
            key,
            ciphertext,
        );

        if (plaintext.byteLength > maximumPlaintextBytes) {
            throw new SessionVaultError("corrupt", "The decrypted vault value exceeds its limit.");
        }

        return new Uint8Array(plaintext);
    } catch (error) {
        if (error instanceof SessionVaultError) {
            throw error;
        }

        throw new SessionVaultError(
            "authentication",
            "The encrypted session vault could not be authenticated.",
            { cause: error },
        );
    } finally {
        iv.fill(0);
        ciphertext.fill(0);
        ownedAdditionalData.fill(0);
    }
}

function recoveryBytes(recoveryKey: string): Uint8Array<ArrayBuffer> {
    if (
        typeof recoveryKey !== "string" ||
        recoveryKey.length === 0 ||
        recoveryKey.length > MAX_RECOVERY_INPUT_BYTES
    ) {
        throw new SessionVaultError("invalid-input", "A recovery key is required.");
    }

    const bytes = new TextEncoder().encode(recoveryKey);

    if (bytes.byteLength === 0 || bytes.byteLength > MAX_RECOVERY_INPUT_BYTES) {
        bytes.fill(0);

        throw new SessionVaultError("invalid-input", "The recovery key has an invalid length.");
    }

    return bytes;
}

async function deriveRecoveryKek(recoveryKey: string, saltValue: string): Promise<CryptoKey> {
    const salt = decodeCanonicalBase64Url(saltValue, "recovery-key salt", {
        exactBytes: SALT_BYTES,
        maximumBytes: SALT_BYTES,
    });
    const input = recoveryBytes(recoveryKey);

    try {
        const material = await requireWebCrypto().importKey("raw", input, "PBKDF2", false, [
            "deriveKey",
        ]);

        return await requireWebCrypto().deriveKey(
            {
                name: "PBKDF2",
                hash: "SHA-512",
                salt,
                iterations: RECOVERY_ITERATIONS,
            },
            material,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
        );
    } finally {
        input.fill(0);
        salt.fill(0);
    }
}

async function deriveWebAuthnKek(
    recordId: string,
    slotId: string,
    prfOutput: Uint8Array<ArrayBuffer>,
    hkdfSaltValue: string,
): Promise<CryptoKey> {
    if (!(prfOutput instanceof Uint8Array) || prfOutput.byteLength !== DEK_BYTES) {
        throw new SessionVaultError("invalid-input", "The WebAuthn PRF output is invalid.");
    }

    const salt = decodeCanonicalBase64Url(hkdfSaltValue, "WebAuthn HKDF salt", {
        exactBytes: SALT_BYTES,
        maximumBytes: SALT_BYTES,
    });
    const info = webAuthnHkdfInfo(recordId, slotId);
    const output = Uint8Array.from(prfOutput);

    try {
        const material = await requireWebCrypto().importKey("raw", output, "HKDF", false, [
            "deriveKey",
        ]);

        return await requireWebCrypto().deriveKey(
            { name: "HKDF", hash: "SHA-256", salt, info },
            material,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
        );
    } finally {
        output.fill(0);
        salt.fill(0);
        info.fill(0);
    }
}

async function wrapDek(
    kek: CryptoKey,
    rawDek: Uint8Array<ArrayBuffer>,
    aad: Uint8Array<ArrayBuffer>,
): Promise<AesGcmBox> {
    return aesEncrypt(kek, rawDek, aad);
}

async function unwrapDek(
    kek: CryptoKey,
    box: AesGcmBox,
    aad: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
    const rawDek = await aesDecrypt(kek, box, aad, DEK_BYTES);

    if (rawDek.byteLength !== DEK_BYTES) {
        rawDek.fill(0);

        throw new SessionVaultError("authentication", "The wrapped payload key is invalid.");
    }

    return rawDek;
}

/** @internal Accepts only a session and storage metadata validated by session-store. */
export async function createSealedRecord(
    session: PersistedMatrixSession,
    storage: VaultStorageMetadata,
    recoveryKey: string,
    webAuthn?: ReadyWebAuthnPrfEnrollment,
): Promise<{ record: LockedMatrixSessionRecordV1; dek: CryptoKey }> {
    const rawDek = randomBytes(DEK_BYTES);
    const recordId = randomBase64UrlBytes(16);
    const recoverySlotBase: Omit<RecoveryKeySlotV1, "wrappedDek"> = {
        kind: "recovery-key-pbkdf2",
        slotId: randomBase64UrlBytes(16),
        salt: randomBase64UrlBytes(SALT_BYTES),
        iterations: RECOVERY_ITERATIONS,
    };
    let copiedPrfOutput: Uint8Array<ArrayBuffer> | undefined;

    try {
        const dek = await importAesKey(rawDek, ["encrypt", "decrypt"]);
        const recoveryKek = await deriveRecoveryKek(recoveryKey, recoverySlotBase.salt);
        const recoverySlot: RecoveryKeySlotV1 = {
            ...recoverySlotBase,
            wrappedDek: await wrapDek(
                recoveryKek,
                rawDek,
                slotAdditionalData(recordId, recoverySlotBase),
            ),
        };
        const unlockSlots: UnlockSlotV1[] = [recoverySlot];

        if (webAuthn) {
            copiedPrfOutput = Uint8Array.from(webAuthn.prfOutput);
            const prfSlotBase: Omit<WebAuthnPrfSlotV1, "wrappedDek"> = {
                kind: "webauthn-prf",
                slotId: randomBase64UrlBytes(16),
                credentialId: webAuthn.credentialId,
                transports: [...webAuthn.transports],
                rpId: webAuthn.rpId,
                prfInput: webAuthn.prfInput,
                hkdfSalt: randomBase64UrlBytes(SALT_BYTES),
            };
            const prfKek = await deriveWebAuthnKek(
                recordId,
                prfSlotBase.slotId,
                copiedPrfOutput,
                prfSlotBase.hkdfSalt,
            );

            unlockSlots.push({
                ...prfSlotBase,
                wrappedDek: await wrapDek(
                    prfKek,
                    rawDek,
                    slotAdditionalData(recordId, prfSlotBase),
                ),
            });
        }

        const revision = 1;
        const plaintext = new TextEncoder().encode(JSON.stringify(session));

        if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
            plaintext.fill(0);

            throw new SessionVaultError(
                "invalid-input",
                "The Matrix session exceeds its vault limit.",
            );
        }

        try {
            const payload = await aesEncrypt(
                dek,
                plaintext,
                payloadAdditionalData(recordId, revision, storage, unlockSlots),
            );

            return {
                dek,
                record: {
                    kind: "locked-matrix-session",
                    schemaVersion: VAULT_SCHEMA_VERSION,
                    recordId,
                    revision,
                    storage: { ...storage },
                    payload,
                    unlockSlots,
                },
            };
        } finally {
            plaintext.fill(0);
        }
    } finally {
        rawDek.fill(0);
        copiedPrfOutput?.fill(0);
        webAuthn?.prfOutput.fill(0);
    }
}

/** @internal The locked record must have passed validateLockedRecord in full. */
export async function unlockDekWithRecoveryKey(
    record: LockedMatrixSessionRecordV1,
    recoveryKey: string,
    slotId?: string,
): Promise<CryptoKey> {
    const matching = record.unlockSlots.filter(
        (slot): slot is RecoveryKeySlotV1 =>
            slot.kind === "recovery-key-pbkdf2" && (!slotId || slot.slotId === slotId),
    );

    if (matching.length !== 1) {
        throw new SessionVaultError("invalid-input", "The recovery-key unlock slot was not found.");
    }

    const slot = matching[0];
    const kek = await deriveRecoveryKek(recoveryKey, slot.salt);
    const rawDek = await unwrapDek(
        kek,
        slot.wrappedDek,
        slotAdditionalData(record.recordId, {
            kind: slot.kind,
            slotId: slot.slotId,
            salt: slot.salt,
            iterations: slot.iterations,
        }),
    );

    try {
        return await importAesKey(rawDek, ["encrypt", "decrypt"]);
    } finally {
        rawDek.fill(0);
    }
}

/** @internal The locked record must have passed validateLockedRecord in full. */
export async function unlockDekWithWebAuthnPrf(
    record: LockedMatrixSessionRecordV1,
    slotId: string,
    evaluate: (slot: WebAuthnPrfSlotInput) => Promise<Uint8Array<ArrayBuffer>>,
): Promise<CryptoKey> {
    const slot = record.unlockSlots.find(
        (candidate): candidate is WebAuthnPrfSlotV1 =>
            candidate.kind === "webauthn-prf" && candidate.slotId === slotId,
    );

    if (!slot) {
        throw new SessionVaultError("invalid-input", "The WebAuthn unlock slot was not found.");
    }

    const output = await evaluate({
        credentialId: slot.credentialId,
        transports: [...slot.transports],
        rpId: slot.rpId,
        prfInput: slot.prfInput,
    });

    try {
        const kek = await deriveWebAuthnKek(record.recordId, slot.slotId, output, slot.hkdfSalt);
        const rawDek = await unwrapDek(
            kek,
            slot.wrappedDek,
            slotAdditionalData(record.recordId, {
                kind: slot.kind,
                slotId: slot.slotId,
                credentialId: slot.credentialId,
                transports: slot.transports,
                rpId: slot.rpId,
                prfInput: slot.prfInput,
                hkdfSalt: slot.hkdfSalt,
            }),
        );

        try {
            return await importAesKey(rawDek, ["encrypt", "decrypt"]);
        } finally {
            rawDek.fill(0);
        }
    } finally {
        output.fill(0);
    }
}

/** @internal The locked record must have passed validateLockedRecord in full. */
export async function decryptSessionPayload(
    record: LockedMatrixSessionRecordV1,
    dek: CryptoKey,
): Promise<unknown> {
    const plaintext = await aesDecrypt(
        dek,
        record.payload,
        payloadAdditionalData(record.recordId, record.revision, record.storage, record.unlockSlots),
        MAX_PAYLOAD_BYTES,
    );

    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    } catch (error) {
        throw new SessionVaultError("corrupt", "The encrypted Matrix session is invalid JSON.", {
            cause: error,
        });
    } finally {
        plaintext.fill(0);
    }
}

/** @internal The locked record must have passed validateLockedRecord in full. */
export async function encryptSessionPayload(
    record: LockedMatrixSessionRecordV1,
    revision: number,
    session: PersistedMatrixSession,
    dek: CryptoKey,
): Promise<AesGcmBox> {
    const plaintext = new TextEncoder().encode(JSON.stringify(session));

    if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
        plaintext.fill(0);

        throw new SessionVaultError("invalid-input", "The Matrix session exceeds its vault limit.");
    }

    try {
        return await aesEncrypt(
            dek,
            plaintext,
            payloadAdditionalData(record.recordId, revision, record.storage, record.unlockSlots),
        );
    } finally {
        plaintext.fill(0);
    }
}
