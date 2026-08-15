import assert from "node:assert/strict";
import test from "node:test";

import {
    createWebAuthnPrfAdapter,
    type PendingWebAuthnPrfEnrollment,
    WebAuthnPrfError,
    type WebAuthnPrfErrorCode,
    type WebAuthnPrfPort,
} from "../lib/security/webauthn-prf";

interface FakePublicKeyCredential extends PublicKeyCredential {
    readonly __fakePublicKeyCredential: true;
}

interface FakePortControls {
    capabilities?: Record<string, boolean> | Error;
    createResult?: unknown | (() => unknown | Promise<unknown>);
    getResult?: unknown | (() => unknown | Promise<unknown>);
    hostname?: string;
    publicKeyCredentialAvailable?: boolean;
    secure?: boolean;
}

function bytes(length: number, value: number): Uint8Array<ArrayBuffer> {
    return new Uint8Array(length).fill(value);
}

function base64Url(value: Uint8Array<ArrayBuffer>): string {
    return Buffer.from(value).toString("base64url");
}

function asBytes(value: BufferSource): number[] {
    return Array.from(
        ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : new Uint8Array(value),
    );
}

function fakeCredential(
    credentialId: Uint8Array<ArrayBuffer>,
    prf: AuthenticationExtensionsPRFOutputs | undefined,
    transports: string[] = ["internal"],
): FakePublicKeyCredential {
    return {
        __fakePublicKeyCredential: true,
        getClientExtensionResults: () => ({ prf }),
        rawId: credentialId.slice().buffer,
        response: {
            getTransports: () => [...transports],
        } as unknown as AuthenticatorAttestationResponse,
    } as unknown as FakePublicKeyCredential;
}

function rejected(name: string): Error {
    const error = new Error(name);

    error.name = name;

    return error;
}

function errorWithCode(code: WebAuthnPrfErrorCode): (error: unknown) => boolean {
    return (error) => error instanceof WebAuthnPrfError && error.code === code;
}

function fakePort(controls: FakePortControls = {}) {
    const createOptions: CredentialCreationOptions[] = [];
    const getOptions: CredentialRequestOptions[] = [];
    let randomInvocation = 0;
    const port: WebAuthnPrfPort = {
        hostname: controls.hostname ?? "vault.example",
        isSecureContext: controls.secure ?? true,
        publicKeyCredentialAvailable: controls.publicKeyCredentialAvailable ?? true,
        async create(options) {
            createOptions.push(options);

            if (typeof controls.createResult === "function") {
                return controls.createResult();
            }

            return controls.createResult;
        },
        async get(options) {
            getOptions.push(options);

            if (typeof controls.getResult === "function") {
                return controls.getResult();
            }

            return controls.getResult;
        },
        async getClientCapabilities() {
            if (controls.capabilities instanceof Error) {
                throw controls.capabilities;
            }

            return controls.capabilities ?? {};
        },
        isPublicKeyCredential(value): value is PublicKeyCredential {
            return Boolean(
                value &&
                typeof value === "object" &&
                "__fakePublicKeyCredential" in value &&
                value.__fakePublicKeyCredential === true,
            );
        },
        randomBytes(length) {
            randomInvocation += 1;

            return bytes(length, randomInvocation);
        },
    };

    return { createOptions, getOptions, port };
}

function pendingSlot(overrides: Partial<PendingWebAuthnPrfEnrollment> = {}) {
    return {
        credentialId: base64Url(bytes(4, 7)),
        kind: "pending",
        prfInput: base64Url(bytes(32, 8)),
        rpId: "vault.example",
        transports: ["internal", "usb"],
        ...overrides,
    } satisfies PendingWebAuthnPrfEnrollment;
}

test("the capability hint is UI-only and cannot prove authenticator PRF support", async () => {
    const credential = fakeCredential(bytes(4, 1), { enabled: false });
    const { port } = fakePort({
        capabilities: { "extension:prf": true },
        createResult: credential,
    });
    const adapter = createWebAuthnPrfAdapter(port);

    assert.equal(await adapter.supportHint(), "likely");
    await assert.rejects(adapter.beginEnrollment(), errorWithCode("unavailable"));
});

test("an absent or failed capability hint remains unknown", async () => {
    const absent = fakePort({ capabilities: {} });
    const failed = fakePort({ capabilities: new Error("capabilities unavailable") });

    assert.equal(await createWebAuthnPrfAdapter(absent.port).supportHint(), "unknown");
    assert.equal(await createWebAuthnPrfAdapter(failed.port).supportHint(), "unknown");
});

test("enrollment accepts an actual 32-byte result without enabled and requests the fixed ceremony", async () => {
    const prfOutput = bytes(32, 0x91);
    const credentialId = bytes(24, 0x37);
    const credential = fakeCredential(credentialId, { results: { first: prfOutput } }, [
        "internal",
        "hybrid",
        "future-transport",
        "internal",
    ]);
    const { createOptions, port } = fakePort({ createResult: credential });
    const enrollment = await createWebAuthnPrfAdapter(port).beginEnrollment();

    assert.equal(enrollment.kind, "ready");
    assert.equal(enrollment.credentialId, base64Url(credentialId));
    assert.equal(enrollment.prfInput, base64Url(bytes(32, 3)));
    assert.deepEqual(enrollment.transports, ["internal", "hybrid"]);
    assert.deepEqual(Array.from(enrollment.prfOutput), Array.from(prfOutput));
    assert.notEqual(enrollment.prfOutput, prfOutput);
    assert.equal(createOptions.length, 1);

    const publicKey = createOptions[0].publicKey;

    assert.ok(publicKey);
    assert.equal(publicKey.rp.id, "vault.example");
    assert.equal(publicKey.rp.name, "Sub-Etha local vault");
    assert.equal(publicKey.user.name, "local-vault");
    assert.equal(publicKey.user.displayName, "Sub-Etha local vault");
    assert.deepEqual(publicKey.pubKeyCredParams, [
        { alg: -7, type: "public-key" },
        { alg: -257, type: "public-key" },
    ]);
    assert.deepEqual(publicKey.authenticatorSelection, {
        residentKey: "preferred",
        userVerification: "required",
    });
    assert.equal(publicKey.attestation, "none");
    assert.deepEqual(asBytes(publicKey.challenge), Array.from(bytes(32, 1)));
    assert.deepEqual(asBytes(publicKey.user.id), Array.from(bytes(32, 2)));
    assert.deepEqual(
        asBytes(publicKey.extensions?.prf?.eval?.first ?? new Uint8Array()),
        Array.from(bytes(32, 3)),
    );
});

test("enabled creation without a result returns a pending enrollment", async () => {
    const credential = fakeCredential(bytes(16, 0x22), { enabled: true }, ["usb"]);
    const { port } = fakePort({ createResult: credential });
    const enrollment = await createWebAuthnPrfAdapter(port).beginEnrollment();

    assert.deepEqual(enrollment, {
        credentialId: base64Url(bytes(16, 0x22)),
        kind: "pending",
        prfInput: base64Url(bytes(32, 3)),
        rpId: "vault.example",
        transports: ["usb"],
    });
});

test("completion and evaluation use one exact credential with UV and accept result without enabled", async () => {
    const slot = pendingSlot();
    const prfOutput = bytes(32, 0x44);
    const credential = fakeCredential(bytes(4, 7), { results: { first: prfOutput } });
    const { getOptions, port } = fakePort({ getResult: credential });
    const adapter = createWebAuthnPrfAdapter(port);
    const completed = await adapter.completeEnrollment(slot);
    const evaluated = await adapter.evaluate(slot);

    assert.deepEqual(completed, { ...slot, kind: "ready", prfOutput });
    assert.deepEqual(Array.from(evaluated), Array.from(prfOutput));
    assert.notEqual(evaluated, prfOutput);
    assert.equal(getOptions.length, 2);

    for (const [index, options] of getOptions.entries()) {
        const publicKey = options.publicKey;

        assert.ok(publicKey);
        assert.equal(publicKey.rpId, slot.rpId);
        assert.equal(publicKey.userVerification, "required");
        assert.deepEqual(asBytes(publicKey.challenge), Array.from(bytes(32, index + 1)));
        assert.equal(publicKey.allowCredentials?.length, 1);
        assert.deepEqual(
            asBytes(publicKey.allowCredentials?.[0].id ?? new Uint8Array()),
            [7, 7, 7, 7],
        );
        assert.deepEqual(publicKey.allowCredentials?.[0].transports, slot.transports);
        assert.deepEqual(
            asBytes(publicKey.extensions?.prf?.eval?.first ?? new Uint8Array()),
            Array.from(bytes(32, 8)),
        );
    }
});

test("a returned credential ID must exactly match the requested credential", async () => {
    const { port } = fakePort({
        getResult: fakeCredential(bytes(4, 9), { results: { first: bytes(32, 1) } }),
    });

    await assert.rejects(
        createWebAuthnPrfAdapter(port).evaluate(pendingSlot()),
        errorWithCode("invalid-response"),
    );
});

test("short and malformed PRF results are rejected", async () => {
    const { port } = fakePort({
        getResult: fakeCredential(bytes(4, 7), { results: { first: bytes(31, 1) } }),
    });

    await assert.rejects(
        createWebAuthnPrfAdapter(port).evaluate(pendingSlot()),
        errorWithCode("invalid-response"),
    );
});

test("NotAllowed and Abort ceremony failures remain typed cancellations", async () => {
    for (const name of ["NotAllowedError", "AbortError"]) {
        const { port } = fakePort({
            createResult: () => Promise.reject(rejected(name)),
        });

        await assert.rejects(
            createWebAuthnPrfAdapter(port).beginEnrollment(),
            errorWithCode("cancelled"),
        );
    }
});

test("unsupported and insecure environments fail before invoking credentials", async () => {
    for (const controls of [
        { publicKeyCredentialAvailable: false },
        { secure: false },
    ] satisfies FakePortControls[]) {
        let createCalls = 0;
        const { port } = fakePort({
            ...controls,
            createResult: () => {
                createCalls += 1;
            },
        });
        const adapter = createWebAuthnPrfAdapter(port);

        assert.equal(await adapter.supportHint(), "unavailable");
        await assert.rejects(
            adapter.beginEnrollment(),
            errorWithCode(controls.secure === false ? "insecure-context" : "unavailable"),
        );
        assert.equal(createCalls, 0);
    }
});

test("attacker-controlled slot fields are canonical and bounded before navigator access", async () => {
    let getCalls = 0;
    const { port } = fakePort({
        getResult: () => {
            getCalls += 1;
        },
    });
    const adapter = createWebAuthnPrfAdapter(port);
    const invalidSlots = [
        pendingSlot({ credentialId: `${base64Url(bytes(4, 7))}=` }),
        pendingSlot({ credentialId: "A".repeat(1367) }),
        pendingSlot({ prfInput: base64Url(bytes(31, 8)) }),
        pendingSlot({ rpId: "other.example" }),
        pendingSlot({ transports: ["internal", "internal"] }),
    ];

    for (const slot of invalidSlots) {
        await assert.rejects(adapter.evaluate(slot), errorWithCode("invalid-input"));
    }

    assert.equal(getCalls, 0);
});
