import { imageSize } from "image-size";

const GIF_87A = "GIF87a";
const GIF_89A = "GIF89a";

export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_DECODED_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_DECODED_BYTES / 4;
export const MAX_IMAGE_EDGE = 16_384;
export const MAX_MEDIA_CACHE_BYTES = 256 * 1024 * 1024;
export const MAX_MEDIA_CACHE_ENTRIES = 96;
export const MAX_CONCURRENT_MEDIA_LOADS = 3;

export type MediaExpectedKind = "image" | "video" | "audio" | "file";

export class MediaLimitError extends Error {
    readonly retryable = false;

    constructor(message: string) {
        super(message);
        this.name = "MediaLimitError";
    }
}

export class MediaTimeoutError extends Error {
    readonly retryable = true;

    constructor(message = "The media download timed out.") {
        super(message);
        this.name = "MediaTimeoutError";
    }
}

interface BoundedResponseOptions {
    signal?: AbortSignal;
    idleTimeoutMs?: number;
    totalTimeoutMs?: number;
}

export interface ImageSafety {
    width: number;
    height: number;
    frameCount: number;
    animated: boolean;
    mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
}

export function isMxcUri(value: unknown): value is string {
    return typeof value === "string" && value.startsWith("mxc://");
}

export function bytesAreGif(bytes: Uint8Array): boolean {
    if (bytes.byteLength < 6) {
        return false;
    }

    const signature = String.fromCharCode(...bytes.slice(0, 6));

    return signature === GIF_87A || signature === GIF_89A;
}

function oversizedMessage(): string {
    return "This attachment exceeds Sub-Etha's 64 MiB automatic preview limit.";
}

export function assertMediaByteLength(byteLength: number, maximumBytes = MAX_MEDIA_BYTES): void {
    if (!Number.isFinite(byteLength) || byteLength < 0 || byteLength > maximumBytes) {
        throw new MediaLimitError(oversizedMessage());
    }
}

export function assertDeclaredMediaLimits(media: {
    size?: number;
    width?: number;
    height?: number;
}): void {
    if (typeof media.size === "number") {
        assertMediaByteLength(media.size);
    }

    if (
        typeof media.width === "number" &&
        (!Number.isFinite(media.width) || media.width <= 0 || media.width > MAX_IMAGE_EDGE)
    ) {
        throw new MediaLimitError("This image exceeds Sub-Etha's automatic preview dimensions.");
    }

    if (
        typeof media.height === "number" &&
        (!Number.isFinite(media.height) || media.height <= 0 || media.height > MAX_IMAGE_EDGE)
    ) {
        throw new MediaLimitError("This image exceeds Sub-Etha's automatic preview dimensions.");
    }

    if (
        typeof media.width === "number" &&
        typeof media.height === "number" &&
        media.width * media.height > MAX_IMAGE_PIXELS
    ) {
        throw new MediaLimitError("This image exceeds Sub-Etha's automatic preview pixel limit.");
    }
}

function timedRead<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            cleanup();
            reject(new MediaTimeoutError());
        }, timeoutMs);

        const onAbort = () => {
            cleanup();
            reject(
                signal?.reason ?? new DOMException("The media download was aborted.", "AbortError"),
            );
        };

        const cleanup = () => {
            if (timer !== null) {
                clearTimeout(timer);
            }

            timer = null;
            signal?.removeEventListener("abort", onAbort);
        };

        if (signal?.aborted) {
            onAbort();

            return;
        }

        signal?.addEventListener("abort", onAbort, { once: true });
        operation.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (error) => {
                cleanup();
                reject(error);
            },
        );
    });
}

export async function readBoundedResponse(
    response: Response,
    maximumBytes = MAX_MEDIA_BYTES,
    options: BoundedResponseOptions = {},
): Promise<ArrayBuffer> {
    const idleTimeoutMs = options.idleTimeoutMs ?? 10_000;
    const totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
    const deadline = Date.now() + totalTimeoutMs;
    const contentLength = response.headers.get("content-length");

    if (contentLength !== null) {
        const declaredLength = Number(contentLength);

        assertMediaByteLength(declaredLength, maximumBytes);
    }

    if (!response.body) {
        const bytes = await timedRead(response.arrayBuffer(), totalTimeoutMs, options.signal);

        assertMediaByteLength(bytes.byteLength, maximumBytes);

        return bytes;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try {
        while (true) {
            const remaining = deadline - Date.now();

            if (remaining <= 0) {
                throw new MediaTimeoutError();
            }

            let result: ReadableStreamReadResult<Uint8Array>;

            try {
                result = await timedRead(
                    reader.read(),
                    Math.min(idleTimeoutMs, remaining),
                    options.signal,
                );
            } catch (error) {
                await reader.cancel(error).catch(() => undefined);

                throw error;
            }

            const { done, value } = result;

            if (done) {
                break;
            }

            total += value.byteLength;

            if (total > maximumBytes) {
                await reader.cancel("Media limit exceeded.").catch(() => undefined);

                throw new MediaLimitError(oversizedMessage());
            }

            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }

    const combined = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return combined.buffer;
}

function skipGifSubBlocks(bytes: Uint8Array, start: number): number {
    let offset = start;

    while (offset < bytes.byteLength) {
        const size = bytes[offset];

        offset += 1;

        if (size === 0) {
            return offset;
        }

        if (offset + size > bytes.byteLength) {
            return bytes.byteLength;
        }

        offset += size;
    }

    return offset;
}

function gifFrameCount(bytes: Uint8Array): number {
    if (!bytesAreGif(bytes) || bytes.byteLength < 13) {
        return 0;
    }

    let offset = 13;
    const packed = bytes[10];

    if ((packed & 0x80) !== 0) {
        offset += 3 * 2 ** ((packed & 0x07) + 1);
    }

    let frames = 0;

    while (offset < bytes.byteLength) {
        const marker = bytes[offset++];

        if (marker === 0x3b) {
            break;
        }

        if (marker === 0x21) {
            offset += 1;
            offset = skipGifSubBlocks(bytes, offset);
            continue;
        }

        if (marker !== 0x2c || offset + 9 > bytes.byteLength) {
            break;
        }

        const imagePacked = bytes[offset + 8];

        offset += 9;

        if ((imagePacked & 0x80) !== 0) {
            offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
        }

        if (offset >= bytes.byteLength) {
            break;
        }

        offset += 1;
        offset = skipGifSubBlocks(bytes, offset);
        frames += 1;
    }

    return frames;
}

function pngFrameCount(bytes: Uint8Array): number {
    if (
        bytes.byteLength < 8 ||
        !bytes
            .slice(0, 8)
            .every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])
    ) {
        return 0;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;

    while (offset + 12 <= bytes.byteLength) {
        const length = view.getUint32(offset);

        if (length > bytes.byteLength - offset - 12) {
            break;
        }

        const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));

        if (type === "acTL" && length >= 8) {
            return view.getUint32(offset + 8);
        }

        offset += 12 + length;
    }

    return 1;
}

function webpFrameCount(bytes: Uint8Array): number {
    if (
        bytes.byteLength < 12 ||
        String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
        String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
    ) {
        return 0;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let frames = 0;
    let offset = 12;

    while (offset + 8 <= bytes.byteLength) {
        const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
        const length = view.getUint32(offset + 4, true);

        if (length > bytes.byteLength - offset - 8) {
            break;
        }

        if (type === "ANMF") {
            frames += 1;
        }

        offset += 8 + length + (length % 2);
    }

    return Math.max(1, frames);
}

function imageFrameCount(bytes: Uint8Array): number {
    if (bytesAreGif(bytes)) {
        return Math.max(1, gifFrameCount(bytes));
    }

    const pngFrames = pngFrameCount(bytes);

    if (pngFrames > 0) {
        return pngFrames;
    }

    const webpFrames = webpFrameCount(bytes);

    return webpFrames > 0 ? webpFrames : 1;
}

function safeRasterMimeType(bytes: Uint8Array): ImageSafety["mimeType"] {
    if (bytesAreGif(bytes)) {
        return "image/gif";
    }

    if (
        bytes.byteLength >= 8 &&
        bytes
            .slice(0, 8)
            .every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])
    ) {
        return "image/png";
    }

    if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }

    if (
        bytes.byteLength >= 12 &&
        String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    ) {
        return "image/webp";
    }

    throw new MediaLimitError("This image format cannot be safely previewed.");
}

export function assertSafeImageBytes(bytes: Uint8Array): ImageSafety {
    const mimeType = safeRasterMimeType(bytes);
    let dimensions: ReturnType<typeof imageSize>;

    try {
        dimensions = imageSize(bytes);
    } catch {
        throw new MediaLimitError("This image format cannot be safely previewed.");
    }

    const { width, height } = dimensions;

    if (
        !width ||
        !height ||
        width > MAX_IMAGE_EDGE ||
        height > MAX_IMAGE_EDGE ||
        width * height > MAX_IMAGE_PIXELS
    ) {
        throw new MediaLimitError("This image exceeds Sub-Etha's automatic preview pixel limit.");
    }

    const frameCount = imageFrameCount(bytes);
    const pixels = width * height;

    if (frameCount > Math.floor(MAX_IMAGE_PIXELS / pixels)) {
        throw new MediaLimitError(
            "This animation exceeds Sub-Etha's automatic preview decode limit.",
        );
    }

    return { width, height, frameCount, animated: frameCount > 1, mimeType };
}

function extensionForMime(mimeType: string): string {
    if (mimeType === "image/gif") {
        return "gif";
    }

    if (mimeType === "image/png") {
        return "png";
    }

    if (mimeType === "image/jpeg") {
        return "jpg";
    }

    if (mimeType === "image/webp") {
        return "webp";
    }

    return "bin";
}

export async function normalizeMediaFile(file: File): Promise<File> {
    let mimeType = file.type.toLowerCase();

    if (!mimeType || mimeType === "application/octet-stream") {
        const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());

        if (bytesAreGif(head)) {
            mimeType = "image/gif";
        }
    }

    if (!mimeType) {
        mimeType = "application/octet-stream";
    }

    const fallbackName = `sub-etha-${Date.now()}.${extensionForMime(mimeType)}`;
    const name = file.name && !file.name.startsWith("image.") ? file.name : fallbackName;

    if (file.type === mimeType && file.name === name) {
        return file;
    }

    return new File([file], name, {
        type: mimeType,
        lastModified: file.lastModified || Date.now(),
    });
}

export function firstImageFile(data: DataTransfer | null): File | null {
    if (!data) {
        return null;
    }

    for (const item of Array.from(data.items ?? [])) {
        if (item.kind !== "file" || (item.type && !item.type.startsWith("image/"))) {
            continue;
        }

        const file = item.getAsFile();

        if (file) {
            return file;
        }
    }

    return (
        Array.from(data.files ?? []).find((file) => !file.type || file.type.startsWith("image/")) ??
        null
    );
}

export function insertAtSelection(
    value: string,
    insertion: string,
    start: number,
    end: number,
): { value: string; caret: number } {
    const safeStart = Math.max(0, Math.min(start, value.length));
    const safeEnd = Math.max(safeStart, Math.min(end, value.length));

    return {
        value: `${value.slice(0, safeStart)}${insertion}${value.slice(safeEnd)}`,
        caret: safeStart + insertion.length,
    };
}

export async function imageDimensions(file: File): Promise<{ width?: number; height?: number }> {
    if (!file.type.startsWith("image/")) {
        return {};
    }

    if ("createImageBitmap" in globalThis) {
        try {
            const bitmap = await createImageBitmap(file);
            const dimensions = { width: bitmap.width, height: bitmap.height };

            bitmap.close();

            return dimensions;
        } catch {
            /* fall through to the image element path */
        }
    }

    if (typeof document === "undefined") {
        return {};
    }

    const url = URL.createObjectURL(file);

    try {
        const image = new Image();

        image.src = url;
        await image.decode();

        return { width: image.naturalWidth, height: image.naturalHeight };
    } finally {
        URL.revokeObjectURL(url);
    }
}
