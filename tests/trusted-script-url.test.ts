import assert from "node:assert/strict";
import test from "node:test";
import type { TrustedTypePolicyFactory } from "trusted-types/lib/index.js";

import {
    SERVICE_WORKER_SCRIPT_PATH,
    trustedServiceWorkerScriptUrl,
    TRUSTED_SERVICE_WORKER_POLICY_NAME,
} from "../lib/security/trusted-script-url";

test("browsers without Trusted Types use the fixed service-worker path", () => {
    assert.equal(trustedServiceWorkerScriptUrl(undefined), SERVICE_WORKER_SCRIPT_PATH);
});

test("the service-worker policy trusts only the fixed script URL", () => {
    let policyName = "";
    let createScriptUrl: ((input: string) => string) | undefined;
    const trustedValue = { trustedScriptUrl: SERVICE_WORKER_SCRIPT_PATH };
    const factory = {
        createPolicy(name: string, rules: { createScriptURL(input: string): string }) {
            policyName = name;
            createScriptUrl = rules.createScriptURL;

            return {
                name,
                createScriptURL(input: string) {
                    rules.createScriptURL(input);

                    return trustedValue;
                },
            };
        },
    } as unknown as TrustedTypePolicyFactory;

    assert.equal(trustedServiceWorkerScriptUrl(factory), trustedValue);
    assert.equal(policyName, TRUSTED_SERVICE_WORKER_POLICY_NAME);
    assert.equal(createScriptUrl?.(SERVICE_WORKER_SCRIPT_PATH), SERVICE_WORKER_SCRIPT_PATH);
    assert.throws(() => createScriptUrl?.("https://attacker.example/sw.js"), TypeError);
});

test("policy creation and Trusted Script URL failures stop registration", () => {
    const creationFailure = {
        createPolicy() {
            throw new TypeError("policy unavailable");
        },
    } as unknown as TrustedTypePolicyFactory;
    const scriptUrlFailure = {
        createPolicy(name: string) {
            return {
                name,
                createScriptURL() {
                    throw new TypeError("script URL unavailable");
                },
            };
        },
    } as unknown as TrustedTypePolicyFactory;

    assert.equal(trustedServiceWorkerScriptUrl(creationFailure), null);
    assert.equal(trustedServiceWorkerScriptUrl(creationFailure), null);
    assert.equal(trustedServiceWorkerScriptUrl(scriptUrlFailure), null);
});
