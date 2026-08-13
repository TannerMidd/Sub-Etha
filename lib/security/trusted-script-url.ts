import type { TrustedScriptURL, TrustedTypePolicyFactory } from "trusted-types/lib/index.js";

export const SERVICE_WORKER_SCRIPT_PATH = "/sw.js";
export const TRUSTED_SERVICE_WORKER_POLICY_NAME = "subetha-service-worker";

interface ScriptUrlPolicy {
    readonly name: string;
    createScriptURL(input: string): TrustedScriptURL;
}

let cachedPolicy: ScriptUrlPolicy | undefined;
let cachedPolicyFactory: TrustedTypePolicyFactory | undefined;
let failedPolicyFactory: TrustedTypePolicyFactory | undefined;

function policyFor(factory: TrustedTypePolicyFactory): ScriptUrlPolicy | undefined {
    if (cachedPolicy && cachedPolicyFactory === factory) {
        return cachedPolicy;
    }

    if (factory === failedPolicyFactory) {
        return undefined;
    }

    try {
        const policy = factory.createPolicy(TRUSTED_SERVICE_WORKER_POLICY_NAME, {
            createScriptURL(input) {
                if (input !== SERVICE_WORKER_SCRIPT_PATH) {
                    throw new TypeError("Only the fixed Sub-Etha service worker URL is trusted");
                }

                return input;
            },
        });

        cachedPolicy = policy;
        cachedPolicyFactory = factory;

        return policy;
    } catch {
        failedPolicyFactory = factory;

        return undefined;
    }
}

export function trustedServiceWorkerScriptUrl(
    factory: TrustedTypePolicyFactory | undefined = (
        globalThis as typeof globalThis & { trustedTypes?: TrustedTypePolicyFactory }
    ).trustedTypes,
): string | TrustedScriptURL | null {
    if (!factory || typeof factory.createPolicy !== "function") {
        return SERVICE_WORKER_SCRIPT_PATH;
    }

    try {
        return policyFor(factory)?.createScriptURL(SERVICE_WORKER_SCRIPT_PATH) ?? null;
    } catch {
        return null;
    }
}
