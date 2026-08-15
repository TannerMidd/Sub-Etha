import { readFile, writeFile } from "node:fs/promises";

const localOutputPath = new URL("../.output/public/sw.js", import.meta.url);
const vercelOutputPath = new URL("../.vercel/output/static/sw.js", import.meta.url);
const candidates = process.env.VERCEL
    ? [vercelOutputPath, localOutputPath]
    : [localOutputPath, vercelOutputPath];
const sentinel = '"__SUB_ETHA_BUILD_ID__"';
let outputPath;
let source;

for (const candidate of candidates) {
    try {
        source = await readFile(candidate, "utf8");
        outputPath = candidate;
        break;
    } catch (error) {
        if (error?.code !== "ENOENT") {
            throw error;
        }
    }
}

if (!outputPath || source === undefined) {
    throw new Error("The built service worker was not found in a supported Nitro output path.");
}

const occurrences = source.split(sentinel).length - 1;

if (occurrences !== 1) {
    throw new Error(`Expected exactly one service-worker build sentinel, found ${occurrences}.`);
}

const rawIdentifier =
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    process.env.VERCEL_DEPLOYMENT_ID ??
    process.env.BUILD_ID ??
    "local";
const identifier =
    rawIdentifier
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[.-]+|[.-]+$/g, "")
        .slice(0, 96) || "local";
const timestamp = `${Date.now()}-${process.hrtime.bigint()}`;
const buildId = `${identifier}-${timestamp}`;
const stamped = source.replace(sentinel, JSON.stringify(buildId));

await writeFile(outputPath, stamped, "utf8");
