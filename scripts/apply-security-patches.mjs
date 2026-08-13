import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const dependencies = [
    {
        name: "flairup",
        version: "1.0.0",
        targets: [
            {
                label: "ESM",
                relativePath: "dist/esm/index.js",
                pristineSha256: "0c93214e55d0017d447a9a26fe05251bba0ba7e4e107e66aa8b076c12e33070d",
                patchedSha256: "00d6688a54f001f1883f4efa5825cd409abc8074c78c3ddccb96888bd3380053",
                transformations: [
                    {
                        from: "    this.styleTag.innerHTML = this.style;",
                        to: "    this.styleTag.textContent = this.style;",
                    },
                    {
                        from: [
                            "    styleTag.id = this.id;",
                            "    (this.rootNode ?? document.head).appendChild(styleTag);",
                        ].join("\n"),
                        to: [
                            "    styleTag.id = this.id;",
                            '    const nonceSource = document.querySelector("script[nonce], style[nonce]");',
                            "    if (nonceSource?.nonce) {",
                            "      styleTag.nonce = nonceSource.nonce;",
                            "    }",
                            "    (this.rootNode ?? document.head).appendChild(styleTag);",
                        ].join("\n"),
                    },
                ],
                assertPatched(source) {
                    assertAbsent(source, "this.styleTag.innerHTML = this.style;");
                    assertOnce(source, "this.styleTag.textContent = this.style;");
                    assertNonceBeforeAppend(source);
                },
            },
            {
                label: "CommonJS",
                relativePath: "dist/index.js",
                pristineSha256: "75bcd4b4f8b39f140d1586269baf4eb731d07fb110bbb110e552049ed379f723",
                patchedSha256: "33c20cd50e736a210377516d9fff03aba598532d4f7d3dff57699193158e69fb",
                transformations: [
                    {
                        from: "                this.styleTag.innerHTML = this.style;",
                        to: "                this.styleTag.textContent = this.style;",
                    },
                    {
                        from: [
                            "                styleTag.id = this.id;",
                            "                var _this_rootNode;",
                        ].join("\n"),
                        to: [
                            "                styleTag.id = this.id;",
                            '                var nonceSource = document.querySelector("script[nonce], style[nonce]");',
                            "                if (nonceSource && nonceSource.nonce) {",
                            "                    styleTag.nonce = nonceSource.nonce;",
                            "                }",
                            "                var _this_rootNode;",
                        ].join("\n"),
                    },
                ],
                assertPatched(source) {
                    assertAbsent(source, "this.styleTag.innerHTML = this.style;");
                    assertOnce(source, "this.styleTag.textContent = this.style;");
                    assertNonceBeforeAppend(source);
                },
            },
        ],
    },
    {
        name: "emoji-picker-react",
        version: "4.19.1",
        targets: [
            {
                label: "ESM",
                relativePath: "dist/emoji-picker-react.esm.js",
                pristineSha256: "eab572a8739a7429c794537ba96a6fd89bd264c8edd3c53f0c1883555bc707f9",
                patchedSha256: "6b84be22277d56e7db828aaeacb7d4a49801b8d943c44a0070ff2101c2d4ddb3",
                transformations: [
                    {
                        from: [
                            "var PickerStyleTag = /*#__PURE__*/memo(function PickerStyleTag(_ref) {",
                            "  var nonce = _ref.nonce;",
                            '  return createElement("style", {',
                            "    nonce: nonce,",
                            "    suppressHydrationWarning: true,",
                            "    dangerouslySetInnerHTML: {",
                            "      __html: stylesheet.getStyle()",
                            "    }",
                            "  });",
                            "});",
                        ].join("\n"),
                        to: [
                            "var PickerStyleTag = /*#__PURE__*/memo(function PickerStyleTag(_ref) {",
                            "  var nonce = _ref.nonce;",
                            '  return createElement("style", {',
                            "    nonce: nonce,",
                            "    suppressHydrationWarning: true,",
                            "    ref: function applyPickerStyles(styleTag) {",
                            "      if (styleTag) {",
                            "        styleTag.textContent = stylesheet.getStyle();",
                            "      }",
                            "    }",
                            "  });",
                            "});",
                        ].join("\n"),
                    },
                ],
                assertPatched: assertEmojiPickerPatched,
            },
            {
                label: "CommonJS development",
                relativePath: "dist/emoji-picker-react.cjs.development.js",
                pristineSha256: "53235b07d3ca663cd52ac1baa9c8cf4d35e642a386dff74498e8ca3913fd0487",
                patchedSha256: "7993639e30116728225e46b557d06ec044bb8c175be01fd213b36861da7cd167",
                transformations: [
                    {
                        from: [
                            "var PickerStyleTag = /*#__PURE__*/React.memo(function PickerStyleTag(_ref) {",
                            "  var nonce = _ref.nonce;",
                            '  return React.createElement("style", {',
                            "    nonce: nonce,",
                            "    suppressHydrationWarning: true,",
                            "    dangerouslySetInnerHTML: {",
                            "      __html: stylesheet.getStyle()",
                            "    }",
                            "  });",
                            "});",
                        ].join("\n"),
                        to: [
                            "var PickerStyleTag = /*#__PURE__*/React.memo(function PickerStyleTag(_ref) {",
                            "  var nonce = _ref.nonce;",
                            '  return React.createElement("style", {',
                            "    nonce: nonce,",
                            "    suppressHydrationWarning: true,",
                            "    ref: function applyPickerStyles(styleTag) {",
                            "      if (styleTag) {",
                            "        styleTag.textContent = stylesheet.getStyle();",
                            "      }",
                            "    }",
                            "  });",
                            "});",
                        ].join("\n"),
                    },
                ],
                assertPatched: assertEmojiPickerPatched,
            },
            {
                label: "CommonJS production",
                relativePath: "dist/emoji-picker-react.cjs.production.min.js",
                pristineSha256: "04b61b087a99cb3099c1456b31d45ef3208be291306aa180f77f4baf92077e18",
                patchedSha256: "0c3c58eea0a8111776e00b6a7fbddcc31d870b464b7b445aa2dd6816bc1ec27e",
                transformations: [
                    {
                        from: 'g=a.memo((function(f){return a.createElement("style",{nonce:f.nonce,suppressHydrationWarning:!0,dangerouslySetInnerHTML:{__html:c.getStyle()}})}))',
                        to: 'g=a.memo((function(f){return a.createElement("style",{nonce:f.nonce,suppressHydrationWarning:!0,ref:function(f){f&&(f.textContent=c.getStyle())}})}))',
                    },
                ],
                assertPatched(source) {
                    assertAbsent(source, "dangerouslySetInnerHTML:{__html:c.getStyle()}");
                    assertOnce(source, "f.textContent=c.getStyle()");
                },
            },
        ],
    },
];

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function occurrenceCount(value, needle) {
    let count = 0;
    let offset = 0;

    while ((offset = value.indexOf(needle, offset)) !== -1) {
        count += 1;
        offset += needle.length;
    }

    return count;
}

function assertAbsent(source, needle) {
    if (occurrenceCount(source, needle) !== 0) {
        throw new Error(`patched output still contains ${JSON.stringify(needle)}`);
    }
}

function assertOnce(source, needle) {
    if (occurrenceCount(source, needle) !== 1) {
        throw new Error(`patched output must contain exactly one ${JSON.stringify(needle)}`);
    }
}

function assertNonceBeforeAppend(source) {
    const nonceLookup = source.indexOf('document.querySelector("script[nonce], style[nonce]")');
    const nonceCopy = source.indexOf("styleTag.nonce = nonceSource.nonce");
    const append = source.indexOf("appendChild(styleTag)");

    if (nonceLookup < 0 || nonceCopy <= nonceLookup || append <= nonceCopy) {
        throw new Error("patched flairup output does not copy the nonce before append");
    }
}

function assertEmojiPickerPatched(source) {
    assertAbsent(source, "dangerouslySetInnerHTML: {\n      __html: stylesheet.getStyle()");
    assertOnce(source, "styleTag.textContent = stylesheet.getStyle();");
    assertOnce(source, "ref: function applyPickerStyles(styleTag)");
}

function applyExactTransformations(target, pristineSource) {
    let patchedSource = pristineSource;

    for (const [index, transformation] of target.transformations.entries()) {
        const pristineCount = occurrenceCount(patchedSource, transformation.from);
        const patchedCount = occurrenceCount(patchedSource, transformation.to);

        if (pristineCount !== 1 || patchedCount !== 0) {
            throw new Error(
                `${target.packageName} ${target.label} transformation ${index + 1} expected one pristine match and no patched matches; found ${pristineCount} and ${patchedCount}`,
            );
        }

        patchedSource = patchedSource.replace(transformation.from, transformation.to);
    }

    return patchedSource;
}

async function prepareTarget(target) {
    const sourceBytes = await readFile(target.path);
    const sourceHash = sha256(sourceBytes);
    const source = sourceBytes.toString("utf8");

    if (sourceHash === target.patchedSha256) {
        target.assertPatched(source);

        return { ...target, state: "already patched", output: null };
    }

    if (sourceHash !== target.pristineSha256) {
        throw new Error(
            `${target.packageName} ${target.label} distribution drifted: got SHA-256 ${sourceHash}; expected pristine ${target.pristineSha256} or patched ${target.patchedSha256}`,
        );
    }

    const patchedSource = applyExactTransformations(target, source);
    const patchedBytes = Buffer.from(patchedSource, "utf8");
    const patchedHash = sha256(patchedBytes);

    if (patchedHash !== target.patchedSha256) {
        throw new Error(
            `${target.packageName} ${target.label} transformation produced unexpected SHA-256 ${patchedHash}; expected ${target.patchedSha256}`,
        );
    }

    target.assertPatched(patchedSource);

    return {
        ...target,
        mode: (await stat(target.path)).mode,
        output: patchedBytes,
        state: "patched",
    };
}

async function atomicWrite(path, output, mode) {
    const temporaryPath = `${path}.subetha-${process.pid}-${randomUUID()}.tmp`;
    let handle;

    try {
        handle = await open(temporaryPath, "wx", mode);
        await handle.writeFile(output);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, path);
    } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);

        throw error;
    }
}

async function main() {
    const targets = [];

    for (const dependency of dependencies) {
        const dependencyRoot = resolve(projectRoot, "node_modules", dependency.name);
        const manifest = JSON.parse(
            await readFile(resolve(dependencyRoot, "package.json"), "utf8"),
        );

        if (manifest.name !== dependency.name || manifest.version !== dependency.version) {
            throw new Error(
                `expected ${dependency.name}@${dependency.version}, found ${String(manifest.name)}@${String(manifest.version)}`,
            );
        }

        targets.push(
            ...dependency.targets.map((target) => ({
                ...target,
                packageName: dependency.name,
                path: resolve(dependencyRoot, target.relativePath),
            })),
        );
    }

    // Preflight every dependency before changing any distribution file.
    const preparedTargets = await Promise.all(targets.map(prepareTarget));

    for (const target of preparedTargets) {
        if (target.output) {
            await atomicWrite(target.path, target.output, target.mode);
            const writtenHash = sha256(await readFile(target.path));

            if (writtenHash !== target.patchedSha256) {
                throw new Error(
                    `${target.packageName} ${target.label} atomic write verification failed: got SHA-256 ${writtenHash}`,
                );
            }
        }

        console.log(`[security-patch] ${target.packageName} ${target.label}: ${target.state}`);
    }
}

main().catch((error) => {
    console.error(`[security-patch] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
