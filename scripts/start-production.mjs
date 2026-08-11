const args = process.argv.slice(2);
const portIndex = args.findIndex((argument) => argument === "--port" || argument === "-p");
const inlinePort = args.find((argument) => argument.startsWith("--port="));
const port =
    (portIndex >= 0 ? args[portIndex + 1] : undefined) ?? inlinePort?.slice("--port=".length);

if (port) {
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535) {
        throw new Error("The production server port is invalid.");
    }

    process.env.NITRO_PORT = port;
}

await import("../.output/server/index.mjs");
