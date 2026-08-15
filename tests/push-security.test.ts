import assert from "node:assert/strict";
import type { LookupAddress } from "node:dns";
import test from "node:test";
import {
    createPublicLookup,
    isPublicIpAddress,
    validPushEndpoint,
    type PushHostResolver,
} from "../lib/push-gateway";
import { pushLimitsFromEnvironment } from "../lib/push-server";

test("Web Push endpoints are restricted to recognized browser providers", () => {
    assert.equal(validPushEndpoint("https://fcm.googleapis.com/fcm/send/example"), true);
    assert.equal(
        validPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/example"),
        true,
    );
    assert.equal(validPushEndpoint("https://web.push.apple.com/example"), true);
    assert.equal(validPushEndpoint("https://wns2-by3p.notify.windows.com/w/?token=example"), true);
    assert.equal(
        validPushEndpoint("https://push.custom.example/device", ["push.custom.example"]),
        true,
    );

    assert.equal(validPushEndpoint("https://attacker.example/device"), false);
    assert.equal(validPushEndpoint("https://push.apple.com.attacker.example/device"), false);
    assert.equal(validPushEndpoint("https://user:secret@fcm.googleapis.com/device"), false);
    assert.equal(validPushEndpoint("https://fcm.googleapis.com:8443/device"), false);
    assert.equal(validPushEndpoint("https://93.184.216.34/device", ["93.184.216.34"]), false);
    assert.equal(validPushEndpoint("https://fcm.googleapis.com/device#fragment"), false);
});

test("push DNS validation accepts only ordinary public-unicast addresses", () => {
    assert.equal(isPublicIpAddress("93.184.216.34"), true);
    assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
    assert.equal(isPublicIpAddress("127.0.0.1"), false);
    assert.equal(isPublicIpAddress("10.0.0.1"), false);
    assert.equal(isPublicIpAddress("169.254.169.254"), false);
    assert.equal(isPublicIpAddress("::1"), false);
    assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);
    assert.equal(isPublicIpAddress("not-an-ip"), false);
});

function runLookup(
    resolver: PushHostResolver,
    options: { all?: boolean; family?: number } = {},
): Promise<{
    error: NodeJS.ErrnoException | null;
    address: string | LookupAddress[];
    family?: number;
}> {
    return new Promise((resolve) => {
        createPublicLookup(resolver)("push.example", options, (error, address, family) => {
            resolve({ error, address, family });
        });
    });
}

test("connect-time lookup rejects private and mixed DNS answers", async () => {
    const privateOnly = await runLookup((_hostname, callback) =>
        callback(null, [{ address: "10.0.0.4", family: 4 }]),
    );

    assert.equal(privateOnly.error?.code, "EACCES");

    const mixed = await runLookup((_hostname, callback) =>
        callback(null, [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 },
        ]),
    );

    assert.equal(mixed.error?.code, "EACCES");

    const publicOnly = await runLookup(
        (_hostname, callback) =>
            callback(null, [
                { address: "93.184.216.34", family: 4 },
                { address: "2606:4700:4700::1111", family: 6 },
            ]),
        { all: true },
    );

    assert.equal(publicOnly.error, null);
    assert.deepEqual(publicOnly.address, [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
    ]);
});

test("invalid push limit overrides fail closed to documented defaults", () => {
    assert.deepEqual(
        pushLimitsFromEnvironment({
            PUSH_MAX_SUBSCRIPTIONS: "0",
            PUSH_REGISTRATION_LIMIT_PER_10M: "-1",
            PUSH_TEST_LIMIT_PER_MIN: "not-a-number",
            PUSH_NOTIFY_LIMIT_PER_MIN: "1.5",
            PUSH_DELIVERY_LIMIT_PER_MIN: "9007199254740992",
        }),
        {
            maxSubscriptions: 10_000,
            maxRevokedManagementKeys: 100_000,
            registrationPerTenMinutes: 300,
            testsPerMinute: 60,
            notifyPerMinute: 600,
            deliveriesPerMinute: 3_000,
        },
    );
    assert.deepEqual(
        pushLimitsFromEnvironment({
            PUSH_MAX_SUBSCRIPTIONS: "25",
            PUSH_MAX_REVOKED_MANAGEMENT_KEYS: "30",
            PUSH_REGISTRATION_LIMIT_PER_10M: "26",
            PUSH_TEST_LIMIT_PER_MIN: "27",
            PUSH_NOTIFY_LIMIT_PER_MIN: "28",
            PUSH_DELIVERY_LIMIT_PER_MIN: "29",
        }),
        {
            maxSubscriptions: 25,
            maxRevokedManagementKeys: 30,
            registrationPerTenMinutes: 26,
            testsPerMinute: 27,
            notifyPerMinute: 28,
            deliveriesPerMinute: 29,
        },
    );
});
