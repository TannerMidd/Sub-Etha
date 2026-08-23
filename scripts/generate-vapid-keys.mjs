import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import webpush from "web-push";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function defaultOutputPath() {
    return resolve(projectRoot, ".local-state", "vapid.json");
}

async function atomicWriteJson(path, value, mode) {
    const payload = `${JSON.stringify(value, null, 4)}\n`;
    const temporaryPath = `${path}.tmp-${process.pid}`;

    const handle = await open(temporaryPath, "wx", mode);

    try {
        await handle.writeFile(payload);
        await handle.sync();
        await handle.close();
    } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);

        throw error;
    }

    await rename(temporaryPath, path);
}

/**
 * Generates a Web Push VAPID key pair once and stores it as JSON so restarts
 * keep serving the same push identity. Existing keys are never overwritten;
 * pass `--force` to replace them. Only the public key is printed; the private
 * key stays in the output file.
 */
async function main() {
    const force = process.argv.includes("--force");
    const positional = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
    const outputPath = positional ?? defaultOutputPath();

    let existing;

    if (!force) {
        try {
            existing = JSON.parse(await readFile(outputPath, "utf8"));
        } catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
        }
    }

    if (existing?.publicKey && existing?.privateKey && !force) {
        console.log(`[vapid] Using existing keys in ${outputPath}`);
        console.log(existing.publicKey);

        return;
    }

    const keys = webpush.generateVAPIDKeys();

    await mkdir(dirname(outputPath), { recursive: true });
    await atomicWriteJson(
        outputPath,
        { publicKey: keys.publicKey, privateKey: keys.privateKey },
        0o600,
    );

    console.log(`[vapid] Generated new VAPID keys in ${outputPath}`);
    console.log(keys.publicKey);
}

main().catch((error) => {
    console.error(`[vapid] ${error instanceof Error ? error.message : String(error)}`);

    process.exitCode = 1;
});
