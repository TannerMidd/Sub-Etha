const CHALLENGE_BYTES = 32;
const USER_HANDLE_BYTES = 32;
const PRF_INPUT_BYTES = 32;
const PRF_OUTPUT_BYTES = 32;
const MAX_CREDENTIAL_ID_BYTES = 1024;
const MAX_RP_ID_CHARACTERS = 253;

const VAULT_USER_NAME = "local-vault";
const VAULT_DISPLAY_NAME = "Sub-Etha local vault";
const VAULT_RP_NAME = "Sub-Etha local vault";

const AUTHENTICATOR_TRANSPORTS = new Set<AuthenticatorTransport>([
    "ble",
    "hybrid",
    "internal",
    "nfc",
    "usb",
]);

export interface WebAuthnPrfSlotInput {
    credentialId: string;
    transports: AuthenticatorTransport[];
    rpId: string;
    prfInput: string;
}

export interface ReadyWebAuthnPrfEnrollment extends WebAuthnPrfSlotInput {
    kind: "ready";
    prfOutput: Uint8Array<ArrayBuffer>;
}

export interface PendingWebAuthnPrfEnrollment extends WebAuthnPrfSlotInput {
    kind: "pending";
}

export type WebAuthnPrfEnrollment = ReadyWebAuthnPrfEnrollment | PendingWebAuthnPrfEnrollment;

export type WebAuthnPrfSupportHint = "likely" | "unknown" | "unavailable";

export type WebAuthnPrfErrorCode =
    | "cancelled"
    | "ceremony-failed"
    | "insecure-context"
    | "invalid-input"
    | "invalid-response"
    | "unavailable";

export class WebAuthnPrfError extends Error {
    readonly code: WebAuthnPrfErrorCode;

    constructor(code: WebAuthnPrfErrorCode, message: string) {
        super(message);
        this.name = "WebAuthnPrfError";
        this.code = code;
    }
}

export interface WebAuthnPrfPort {
    readonly hostname: string;
    readonly isSecureContext: boolean;
    readonly publicKeyCredentialAvailable: boolean;
    create(options: CredentialCreationOptions): Promise<unknown>;
    get(options: CredentialRequestOptions): Promise<unknown>;
    getClientCapabilities?(): Promise<Record<string, boolean>>;
    isPublicKeyCredential(value: unknown): value is PublicKeyCredential;
    randomBytes(length: number): Uint8Array<ArrayBuffer>;
}

export interface WebAuthnPrfAdapter {
    supportHint(): Promise<WebAuthnPrfSupportHint>;
    beginEnrollment(): Promise<WebAuthnPrfEnrollment>;
    completeEnrollment(pending: PendingWebAuthnPrfEnrollment): Promise<ReadyWebAuthnPrfEnrollment>;
    evaluate(slot: WebAuthnPrfSlotInput): Promise<Uint8Array<ArrayBuffer>>;
}

function invalidInput(message: string): WebAuthnPrfError {
    return new WebAuthnPrfError("invalid-input", message);
}

function copyBytes(value: BufferSource, field: string): Uint8Array<ArrayBuffer> {
    try {
        const view = ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value);

        return Uint8Array.from(view);
    } catch {
        throw new WebAuthnPrfError("invalid-response", `${field} was not binary data.`);
    }
}

function encodeBase64Url(value: Uint8Array<ArrayBuffer>): string {
    let binary = "";

    for (const byte of value) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCanonicalBase64Url(
    value: unknown,
    field: string,
    minimumBytes: number,
    maximumBytes: number,
): Uint8Array<ArrayBuffer> {
    const minimumCharacters = Math.ceil((minimumBytes * 4) / 3);
    const maximumCharacters = Math.ceil((maximumBytes * 4) / 3);

    if (
        typeof value !== "string" ||
        value.length < minimumCharacters ||
        value.length > maximumCharacters ||
        value.length % 4 === 1 ||
        !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
        throw invalidInput(`${field} must be canonical unpadded base64url.`);
    }

    let decoded: Uint8Array<ArrayBuffer>;

    try {
        const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
        const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));

        decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    } catch {
        throw invalidInput(`${field} must be valid base64url.`);
    }

    if (
        decoded.byteLength < minimumBytes ||
        decoded.byteLength > maximumBytes ||
        encodeBase64Url(decoded) !== value
    ) {
        throw invalidInput(`${field} has an invalid encoding or length.`);
    }

    return decoded;
}

function validatedRandomBytes(
    port: WebAuthnPrfPort,
    length: number,
    purpose: string,
): Uint8Array<ArrayBuffer> {
    let value: Uint8Array<ArrayBuffer>;

    try {
        value = port.randomBytes(length);
    } catch {
        throw new WebAuthnPrfError(
            "ceremony-failed",
            `Secure randomness for ${purpose} was unavailable.`,
        );
    }

    if (!(value instanceof Uint8Array) || value.byteLength !== length) {
        throw new WebAuthnPrfError(
            "ceremony-failed",
            `Secure randomness for ${purpose} was unavailable.`,
        );
    }

    return Uint8Array.from(value);
}

function requireCeremonyPort(port: WebAuthnPrfPort): string {
    if (!port.isSecureContext) {
        throw new WebAuthnPrfError(
            "insecure-context",
            "A secure context is required for device unlock.",
        );
    }

    if (!port.publicKeyCredentialAvailable) {
        throw new WebAuthnPrfError("unavailable", "WebAuthn is unavailable in this browser.");
    }

    if (
        typeof port.hostname !== "string" ||
        port.hostname.length === 0 ||
        port.hostname.length > MAX_RP_ID_CHARACTERS
    ) {
        throw new WebAuthnPrfError("unavailable", "The current WebAuthn RP ID is invalid.");
    }

    const hostnameHasForbiddenCharacter = [...port.hostname].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;

        return codePoint <= 0x20 || codePoint === 0x7f || character === "/" || character === "\\";
    });

    if (hostnameHasForbiddenCharacter) {
        throw new WebAuthnPrfError("unavailable", "The current WebAuthn RP ID is invalid.");
    }

    return port.hostname;
}

function validateTransports(value: unknown): AuthenticatorTransport[] {
    if (!Array.isArray(value) || value.length > AUTHENTICATOR_TRANSPORTS.size) {
        throw invalidInput("Authenticator transports are invalid.");
    }

    const transports: AuthenticatorTransport[] = [];

    for (const transport of value) {
        if (
            typeof transport !== "string" ||
            !AUTHENTICATOR_TRANSPORTS.has(transport as AuthenticatorTransport) ||
            transports.includes(transport as AuthenticatorTransport)
        ) {
            throw invalidInput("Authenticator transports are invalid.");
        }

        transports.push(transport as AuthenticatorTransport);
    }

    return transports;
}

function transportsFromCredential(credential: PublicKeyCredential): AuthenticatorTransport[] {
    const response = credential.response as AuthenticatorResponse & {
        getTransports?: () => string[];
    };

    if (typeof response.getTransports !== "function") {
        return [];
    }

    let reported: string[];

    try {
        reported = response.getTransports.call(response);
    } catch {
        return [];
    }

    if (!Array.isArray(reported)) {
        return [];
    }

    return reported.filter(
        (transport, index): transport is AuthenticatorTransport =>
            AUTHENTICATOR_TRANSPORTS.has(transport as AuthenticatorTransport) &&
            reported.indexOf(transport) === index,
    );
}

function validateSlot(
    slot: WebAuthnPrfSlotInput,
    currentRpId: string,
): {
    credentialId: Uint8Array<ArrayBuffer>;
    prfInput: Uint8Array<ArrayBuffer>;
    transports: AuthenticatorTransport[];
} {
    if (!slot || typeof slot !== "object") {
        throw invalidInput("The WebAuthn PRF slot is invalid.");
    }

    if (slot.rpId !== currentRpId) {
        throw invalidInput("The WebAuthn PRF slot belongs to a different RP ID.");
    }

    return {
        credentialId: decodeCanonicalBase64Url(
            slot.credentialId,
            "credentialId",
            1,
            MAX_CREDENTIAL_ID_BYTES,
        ),
        prfInput: decodeCanonicalBase64Url(
            slot.prfInput,
            "prfInput",
            PRF_INPUT_BYTES,
            PRF_INPUT_BYTES,
        ),
        transports: validateTransports(slot.transports),
    };
}

function credentialDetails(
    port: WebAuthnPrfPort,
    value: unknown,
): {
    credential: PublicKeyCredential;
    credentialId: Uint8Array<ArrayBuffer>;
} {
    if (!port.isPublicKeyCredential(value)) {
        throw new WebAuthnPrfError(
            "invalid-response",
            "The browser did not return a public-key credential.",
        );
    }

    let credentialId: Uint8Array<ArrayBuffer>;

    try {
        credentialId = copyBytes(value.rawId, "credential raw ID");
    } catch {
        throw new WebAuthnPrfError(
            "invalid-response",
            "The browser returned an invalid credential ID.",
        );
    }

    if (credentialId.byteLength < 1 || credentialId.byteLength > MAX_CREDENTIAL_ID_BYTES) {
        throw new WebAuthnPrfError(
            "invalid-response",
            "The browser returned an invalid credential ID.",
        );
    }

    return { credential: value, credentialId };
}

function readExtensionResults(
    credential: PublicKeyCredential,
): AuthenticationExtensionsClientOutputs {
    try {
        return credential.getClientExtensionResults();
    } catch {
        throw new WebAuthnPrfError(
            "invalid-response",
            "The browser did not return WebAuthn extension results.",
        );
    }
}

function prfResult(
    extensionResults: AuthenticationExtensionsClientOutputs,
    required: boolean,
): Uint8Array<ArrayBuffer> | undefined {
    const first = extensionResults.prf?.results?.first;

    if (first === undefined) {
        if (required) {
            throw new WebAuthnPrfError(
                "invalid-response",
                "The authenticator did not return a PRF result.",
            );
        }

        return undefined;
    }

    const result = copyBytes(first, "PRF result");

    if (result.byteLength !== PRF_OUTPUT_BYTES) {
        throw new WebAuthnPrfError(
            "invalid-response",
            "The authenticator returned an invalid PRF result.",
        );
    }

    return result;
}

function equalBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): boolean {
    if (left.byteLength !== right.byteLength) {
        return false;
    }

    let difference = 0;

    for (let index = 0; index < left.byteLength; index += 1) {
        difference |= left[index] ^ right[index];
    }

    return difference === 0;
}

function ceremonyError(error: unknown): WebAuthnPrfError {
    if (error instanceof WebAuthnPrfError) {
        return error;
    }

    const name =
        error && typeof error === "object" && "name" in error
            ? String((error as { name?: unknown }).name)
            : "";

    if (name === "NotAllowedError" || name === "AbortError") {
        return new WebAuthnPrfError("cancelled", "Device unlock was cancelled.");
    }

    if (name === "NotSupportedError" || name === "SecurityError") {
        return new WebAuthnPrfError(
            "unavailable",
            "The authenticator cannot provide WebAuthn PRF unlock.",
        );
    }

    return new WebAuthnPrfError("ceremony-failed", "The WebAuthn ceremony failed.");
}

async function getCredential(
    port: WebAuthnPrfPort,
    slot: WebAuthnPrfSlotInput,
): Promise<{
    credential: PublicKeyCredential;
    output: Uint8Array<ArrayBuffer>;
}> {
    const rpId = requireCeremonyPort(port);
    const validated = validateSlot(slot, rpId);
    const challenge = validatedRandomBytes(port, CHALLENGE_BYTES, "the WebAuthn challenge");
    let result: unknown;

    try {
        result = await port.get({
            publicKey: {
                allowCredentials: [
                    {
                        id: validated.credentialId,
                        transports: validated.transports,
                        type: "public-key",
                    },
                ],
                challenge,
                extensions: { prf: { eval: { first: validated.prfInput } } },
                rpId,
                userVerification: "required",
            },
        });
    } catch (error) {
        throw ceremonyError(error);
    }

    const returned = credentialDetails(port, result);

    if (!equalBytes(returned.credentialId, validated.credentialId)) {
        throw new WebAuthnPrfError(
            "invalid-response",
            "The authenticator returned a different credential.",
        );
    }

    return {
        credential: returned.credential,
        output: prfResult(readExtensionResults(returned.credential), true)!,
    };
}

export function createWebAuthnPrfAdapter(port: WebAuthnPrfPort): WebAuthnPrfAdapter {
    return {
        async supportHint() {
            if (!port.isSecureContext || !port.publicKeyCredentialAvailable) {
                return "unavailable";
            }

            if (!port.getClientCapabilities) {
                return "unknown";
            }

            try {
                const capabilities = await port.getClientCapabilities();

                if (!("extension:prf" in capabilities)) {
                    return "unknown";
                }

                return capabilities["extension:prf"] === true ? "likely" : "unavailable";
            } catch {
                return "unknown";
            }
        },

        async beginEnrollment() {
            const rpId = requireCeremonyPort(port);
            const challenge = validatedRandomBytes(port, CHALLENGE_BYTES, "the WebAuthn challenge");
            const userId = validatedRandomBytes(
                port,
                USER_HANDLE_BYTES,
                "the WebAuthn user handle",
            );
            const prfInput = validatedRandomBytes(port, PRF_INPUT_BYTES, "the PRF input");
            let result: unknown;

            try {
                result = await port.create({
                    publicKey: {
                        attestation: "none",
                        authenticatorSelection: {
                            residentKey: "preferred",
                            userVerification: "required",
                        },
                        challenge,
                        extensions: { prf: { eval: { first: prfInput } } },
                        pubKeyCredParams: [
                            { alg: -7, type: "public-key" },
                            { alg: -257, type: "public-key" },
                        ],
                        rp: { id: rpId, name: VAULT_RP_NAME },
                        user: {
                            displayName: VAULT_DISPLAY_NAME,
                            id: userId,
                            name: VAULT_USER_NAME,
                        },
                    },
                });
            } catch (error) {
                throw ceremonyError(error);
            }

            const returned = credentialDetails(port, result);
            const extensionResults = readExtensionResults(returned.credential);
            const output = prfResult(extensionResults, false);
            const slot = {
                credentialId: encodeBase64Url(returned.credentialId),
                prfInput: encodeBase64Url(prfInput),
                rpId,
                transports: transportsFromCredential(returned.credential),
            } satisfies WebAuthnPrfSlotInput;

            if (output) {
                return { ...slot, kind: "ready", prfOutput: output };
            }

            if (extensionResults.prf?.enabled === true) {
                return { ...slot, kind: "pending" };
            }

            throw new WebAuthnPrfError(
                "unavailable",
                "The authenticator did not enable the WebAuthn PRF extension.",
            );
        },

        async completeEnrollment(pending) {
            if (!pending || pending.kind !== "pending") {
                throw invalidInput("A pending WebAuthn PRF enrollment is required.");
            }

            const { output } = await getCredential(port, pending);

            return {
                credentialId: pending.credentialId,
                kind: "ready",
                prfInput: pending.prfInput,
                prfOutput: output,
                rpId: pending.rpId,
                transports: [...pending.transports],
            };
        },

        async evaluate(slot) {
            return (await getCredential(port, slot)).output;
        },
    };
}

function productionPort(): WebAuthnPrfPort {
    const credentialConstructor = globalThis.PublicKeyCredential;
    const credentials = typeof navigator === "undefined" ? undefined : navigator.credentials;

    return {
        hostname: typeof location === "undefined" ? "" : location.hostname,
        isSecureContext: globalThis.isSecureContext === true,
        publicKeyCredentialAvailable:
            typeof credentialConstructor === "function" &&
            typeof credentials?.create === "function" &&
            typeof credentials.get === "function",
        create: (options) => {
            if (!credentials) {
                throw new WebAuthnPrfError("unavailable", "WebAuthn is unavailable.");
            }

            return credentials.create(options);
        },
        get: (options) => {
            if (!credentials) {
                throw new WebAuthnPrfError("unavailable", "WebAuthn is unavailable.");
            }

            return credentials.get(options);
        },
        getClientCapabilities:
            typeof credentialConstructor?.getClientCapabilities === "function"
                ? () => credentialConstructor.getClientCapabilities()
                : undefined,
        isPublicKeyCredential: (value): value is PublicKeyCredential =>
            typeof credentialConstructor === "function" && value instanceof credentialConstructor,
        randomBytes(length) {
            return crypto.getRandomValues(new Uint8Array(length));
        },
    };
}

export async function webAuthnPrfSupportHint(): Promise<WebAuthnPrfSupportHint> {
    return createWebAuthnPrfAdapter(productionPort()).supportHint();
}

export async function beginWebAuthnPrfEnrollment(): Promise<WebAuthnPrfEnrollment> {
    return createWebAuthnPrfAdapter(productionPort()).beginEnrollment();
}

export async function completeWebAuthnPrfEnrollment(
    pending: PendingWebAuthnPrfEnrollment,
): Promise<ReadyWebAuthnPrfEnrollment> {
    return createWebAuthnPrfAdapter(productionPort()).completeEnrollment(pending);
}

export async function evaluateWebAuthnPrf(
    slot: WebAuthnPrfSlotInput,
): Promise<Uint8Array<ArrayBuffer>> {
    return createWebAuthnPrfAdapter(productionPort()).evaluate(slot);
}
