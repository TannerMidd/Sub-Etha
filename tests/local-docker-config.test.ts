import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

function assertSupportedVapidSubject(subject: string): void {
    const protocol = new URL(subject).protocol;

    assert.ok(
        protocol === "https:" || protocol === "mailto:",
        `VAPID subject must use https: or mailto:, received ${subject}`,
    );
}

test("local Docker VAPID defaults use supported contact URIs", async () => {
    const [compose, entrypoint] = await Promise.all([
        readFile(`${PROJECT_ROOT}/docker-compose.yml`, "utf8"),
        readFile(`${PROJECT_ROOT}/docker/entrypoint.sh`, "utf8"),
    ]);
    const composeDefault = compose.match(
        /VAPID_SUBJECT:\s+\$\{VAPID_SUBJECT:-([^}]+)\}/,
    )?.[1];
    const entrypointDefault = entrypoint.match(/VAPID_SUBJECT="([^"]+)"/)?.[1];

    assert.ok(composeDefault, "Compose must define a default VAPID subject.");
    assert.ok(entrypointDefault, "The container entrypoint must define a fallback VAPID subject.");
    assertSupportedVapidSubject(composeDefault);
    assertSupportedVapidSubject(entrypointDefault);
});
