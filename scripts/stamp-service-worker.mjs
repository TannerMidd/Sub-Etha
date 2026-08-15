import { readFile, writeFile } from "node:fs/promises";

const outputPath = new URL("../.output/public/sw.js", import.meta.url);
const sentinel = '"__SUB_ETHA_BUILD_ID__"';
const source = await readFile(outputPath, "utf8");
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
