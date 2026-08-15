const GIF_87A = "GIF87a";
const GIF_89A = "GIF89a";

export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** Backwards-compatible alias for image preview limits. */
export const MAX_MEDIA_BYTES = MAX_IMAGE_BYTES;
export const MAX_NONIMAGE_MEDIA_BYTES = 128 * 1024 * 1024;
export const MAX_PLAIN_UPLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_ENCRYPTED_UPLOAD_BYTES = 128 * 1024 * 1024;
export const MAX_AVATAR_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_DECODED_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = MAX_IMAGE_DECODED_BYTES / 4;
export const MAX_IMAGE_EDGE = 16_384;
export const MAX_MEDIA_CACHE_BYTES = 128 * 1024 * 1024;
export const MAX_MEDIA_CACHE_ENTRIES = 96;
export const MAX_MEDIA_OPERATION_QUEUE = 3;
export const MAX_MEDIA_OPERATION_CAPACITY = 4;
export const MAX_QUEUED_MEDIA_BYTES = 256 * 1024 * 1024;
// Conservative policy accounting: active work 512 MiB + queued source refs
// 256 MiB + settled cache 128 MiB ~= 896 MiB. Browser, SDK, crypto, fetch,
// parser, and native decode copies may exceed this accounting; it is not an
// OOM guarantee.
export const MAX_ACTIVE_MEDIA_ACCOUNTED_BYTES = 512 * 1024 * 1024;
export const MAX_MEDIA_MEMORY_ACCOUNTED_BYTES =
    MAX_ACTIVE_MEDIA_ACCOUNTED_BYTES + MAX_QUEUED_MEDIA_BYTES + MAX_MEDIA_CACHE_BYTES;
export const MAX_MEDIA_CONFIG_BYTES = 16 * 1024;
export const MEDIA_IMAGE_DEADLINE_MS = 30_000;
export const MEDIA_NONIMAGE_DEADLINE_MS = 5 * 60_000;
export const MEDIA_IDLE_TIMEOUT_MS = 10_000;

export type MediaExpectedKind = "image" | "video" | "audio" | "file";

export class MediaLimitError extends Error {
    readonly retryable = false;

    constructor(message: string) {
        super(message);
        this.name = "MediaLimitError";
    }
}

export class MediaBusyError extends Error {
    readonly retryable = true;

    constructor(message = "Media preparation is busy. Try again shortly.") {
        super(message);
        this.name = "MediaBusyError";
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
    deadlineAt?: number;
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

function oversizedMessage(maximumBytes: number): string {
    const mebibytes = Math.max(1, Math.round(maximumBytes / (1024 * 1024)));

    return `This attachment exceeds Sub-Etha's ${mebibytes} MiB media limit.`;
}

export function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function assertMediaByteLength(byteLength: number, maximumBytes = MAX_IMAGE_BYTES): void {
    if (
        !isSafeNonNegativeInteger(byteLength) ||
        !isSafeNonNegativeInteger(maximumBytes) ||
        byteLength > maximumBytes
    ) {
        throw new MediaLimitError(oversizedMessage(maximumBytes));
    }
}

export function assertDeclaredMediaLimits(
    media: {
        size?: number;
        width?: number;
        height?: number;
    },
    maximumBytes = MAX_IMAGE_BYTES,
): void {
    if (media.size !== undefined) {
        assertMediaByteLength(media.size, maximumBytes);
    }

    for (const dimension of [media.width, media.height]) {
        if (
            dimension !== undefined &&
            (!isSafeNonNegativeInteger(dimension) || dimension <= 0 || dimension > MAX_IMAGE_EDGE)
        ) {
            throw new MediaLimitError(
                "This image exceeds Sub-Etha's automatic preview dimensions.",
            );
        }
    }

    if (
        media.width !== undefined &&
        media.height !== undefined &&
        media.width * media.height > MAX_IMAGE_PIXELS
    ) {
        throw new MediaLimitError("This image exceeds Sub-Etha's automatic preview pixel limit.");
    }
}

interface MediaOperationNode {
    reservationBytes: number;
    controller: AbortController;
    resolve: (lease: MediaOperationLease) => void;
    reject: (error: unknown) => void;
    queued: boolean;
    released: boolean;
    cleanup?: () => void;
    start?: () => void;
}

export interface MediaOperationLease {
    readonly signal: AbortSignal;
    readonly reservationBytes: number;
    release(): void;
}

/**
 * Serialises memory-heavy media operations. A lease is intentionally held until
 * awaited parser/decrypt/native work settles; callers must not release it from
 * an abort handler.
 */
export class MediaOperationGate {
    private active: MediaOperationNode | null = null;
    private queue: MediaOperationNode[] = [];
    private queuedBytes = 0;
    private closed = false;

    acquire(reservationBytes: number, externalSignal?: AbortSignal): Promise<MediaOperationLease> {
        if (!isSafeNonNegativeInteger(reservationBytes)) {
            return Promise.reject(new MediaLimitError("The media reservation is invalid."));
        }

        if (this.closed || externalSignal?.aborted) {
            return Promise.reject(
                externalSignal?.reason ?? new MediaBusyError("Media preparation is closed."),
            );
        }

        if (
            this.queue.length + (this.active ? 1 : 0) >= MAX_MEDIA_OPERATION_CAPACITY ||
            this.queue.length >= MAX_MEDIA_OPERATION_QUEUE ||
            this.queuedBytes + reservationBytes > MAX_QUEUED_MEDIA_BYTES
        ) {
            return Promise.reject(new MediaBusyError());
        }

        const node: MediaOperationNode = {
            reservationBytes,
            controller: new AbortController(),
            resolve: () => undefined,
            reject: () => undefined,
            queued: true,
            released: false,
        };
        const promise = new Promise<MediaOperationLease>((resolve, reject) => {
            node.resolve = resolve;
            node.reject = reject;
        });
        const abort = () => this.abortNode(node, externalSignal?.reason);

        externalSignal?.addEventListener("abort", abort, { once: true });
        node.cleanup = () => externalSignal?.removeEventListener("abort", abort);

        node.start = () => {
            if (this.closed || node.released) {
                node.cleanup?.();

                return;
            }

            node.queued = false;
            this.active = node;
            node.resolve({
                signal: node.controller.signal,
                reservationBytes,
                release: () => {
                    if (node.released) {
                        return;
                    }

                    node.released = true;
                    node.cleanup?.();

                    if (this.active === node) {
                        this.active = null;
                        this.pump();
                    }
                },
            });
        };

        this.queue.push(node);
        this.queuedBytes += reservationBytes;
        this.pump();

        return promise;
    }

    close(reason: unknown = new MediaBusyError("Media preparation was closed.")): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        const queued = this.queue.splice(0);

        this.queuedBytes = 0;

        for (const node of queued) {
            node.released = true;
            node.cleanup?.();
            node.reject(reason);
        }

        this.active?.controller.abort(reason);
    }

    private abortNode(node: MediaOperationNode, reason: unknown): void {
        if (node.released) {
            return;
        }

        if (node.queued) {
            const index = this.queue.indexOf(node);

            if (index >= 0) {
                this.queue.splice(index, 1);
                this.queuedBytes = Math.max(0, this.queuedBytes - node.reservationBytes);
            }

            node.released = true;
            node.cleanup?.();
            node.reject(
                reason ?? new DOMException("The media operation was aborted.", "AbortError"),
            );

            return;
        }

        node.controller.abort(reason);
    }

    private pump(): void {
        if (this.active || this.closed) {
            return;
        }

        const node = this.queue.shift();

        if (!node) {
            return;
        }

        this.queuedBytes = Math.max(0, this.queuedBytes - node.reservationBytes);
        node.start?.();
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
    maximumBytes = MAX_IMAGE_BYTES,
    options: BoundedResponseOptions = {},
): Promise<ArrayBuffer> {
    const idleTimeoutMs = options.idleTimeoutMs ?? MEDIA_IDLE_TIMEOUT_MS;
    const totalTimeoutMs = options.totalTimeoutMs ?? 30_000;
    const deadline = options.deadlineAt ?? Date.now() + totalTimeoutMs;
    const contentLength = response.headers.get("content-length");

    if (contentLength !== null) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
            await response.body?.cancel("Malformed Content-Length.").catch(() => undefined);

            throw new MediaLimitError("The homeserver returned an invalid media length.");
        }

        const declaredLength = Number(contentLength);

        try {
            assertMediaByteLength(declaredLength, maximumBytes);
        } catch (error) {
            await response.body?.cancel("Media limit exceeded.").catch(() => undefined);

            throw error;
        }
    }

    if (!response.body) {
        const remaining = deadline - Date.now();

        if (remaining <= 0) {
            throw new MediaTimeoutError();
        }

        const bytes = await timedRead(response.arrayBuffer(), remaining, options.signal);

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
                await reader.cancel(new MediaTimeoutError()).catch(() => undefined);

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

                throw new MediaLimitError(oversizedMessage(maximumBytes));
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

interface ImageFrameRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

function validateFrameRects(
    frames: ImageFrameRect[],
    canvasWidth: number,
    canvasHeight: number,
): void {
    for (const frame of frames) {
        if (
            !isSafeNonNegativeInteger(frame.x) ||
            !isSafeNonNegativeInteger(frame.y) ||
            !isSafeNonNegativeInteger(frame.width) ||
            !isSafeNonNegativeInteger(frame.height) ||
            frame.width <= 0 ||
            frame.height <= 0 ||
            frame.width > MAX_IMAGE_EDGE ||
            frame.height > MAX_IMAGE_EDGE ||
            frame.width * frame.height > MAX_IMAGE_PIXELS ||
            frame.x + frame.width > canvasWidth ||
            frame.y + frame.height > canvasHeight
        ) {
            throw new MediaLimitError("This animation exceeds Sub-Etha's frame safety limits.");
        }
    }
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

function gifFrameRects(bytes: Uint8Array): ImageFrameRect[] {
    if (!bytesAreGif(bytes) || bytes.byteLength < 13) {
        return [];
    }

    let offset = 13;
    const packed = bytes[10];

    if ((packed & 0x80) !== 0) {
        offset += 3 * 2 ** ((packed & 0x07) + 1);
    }

    const frames: ImageFrameRect[] = [];

    while (offset < bytes.byteLength) {
        const marker = bytes[offset++];

        if (marker === 0x3b) {
            break;
        }

        if (marker === 0x21) {
            if (offset >= bytes.byteLength) {
                break;
            }

            offset += 1;
            offset = skipGifSubBlocks(bytes, offset);
            continue;
        }

        if (marker !== 0x2c || offset + 9 > bytes.byteLength) {
            break;
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

        frames.push({
            x: view.getUint16(offset, true),
            y: view.getUint16(offset + 2, true),
            width: view.getUint16(offset + 4, true),
            height: view.getUint16(offset + 6, true),
        });
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

function pngFrameRects(bytes: Uint8Array): ImageFrameRect[] {
    if (
        bytes.byteLength < 8 ||
        !bytes
            .slice(0, 8)
            .every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])
    ) {
        return [];
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames: ImageFrameRect[] = [];
    let offset = 8;

    while (offset + 12 <= bytes.byteLength) {
        const length = view.getUint32(offset);

        if (length > bytes.byteLength - offset - 12) {
            break;
        }

        const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));

        if (type === "fcTL" && length >= 26) {
            frames.push({
                x: view.getUint32(offset + 20),
                y: view.getUint32(offset + 24),
                width: view.getUint32(offset + 12),
                height: view.getUint32(offset + 16),
            });
        }

        offset += 12 + length;
    }

    return frames;
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

function webpFrameRects(bytes: Uint8Array): ImageFrameRect[] {
    if (
        bytes.byteLength < 12 ||
        String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
        String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
    ) {
        return [];
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const frames: ImageFrameRect[] = [];
    let offset = 12;

    while (offset + 8 <= bytes.byteLength) {
        const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
        const length = view.getUint32(offset + 4, true);

        if (length > bytes.byteLength - offset - 8) {
            break;
        }

        if (type === "ANMF" && length < 16) {
            throw new MediaLimitError("This animation has invalid frame metadata.");
        }

        if (type === "ANMF" && length >= 16) {
            const dataOffset = offset + 8;
            const uint24 = (at: number) => bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);

            frames.push({
                x: uint24(dataOffset) * 2,
                y: uint24(dataOffset + 3) * 2,
                width: uint24(dataOffset + 6) + 1,
                height: uint24(dataOffset + 9) + 1,
            });
        }

        offset += 8 + length + (length % 2);
    }

    return frames;
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

interface ImageDimensions {
    width: number;
    height: number;
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | null {
    if (!bytesAreGif(bytes) || bytes.byteLength < 13) {
        return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | null {
    if (bytes.byteLength < 24 || pngFrameCount(bytes) === 0) {
        return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const chunkType = String.fromCharCode(...bytes.slice(12, 16));

    if (view.getUint32(8) !== 13 || chunkType !== "IHDR") {
        return null;
    }

    return { width: view.getUint32(16), height: view.getUint32(20) };
}

function isJpegStartOfFrame(marker: number): boolean {
    return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | null {
    if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return null;
    }

    let offset = 2;

    while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
            return null;
        }

        while (offset < bytes.byteLength && bytes[offset] === 0xff) {
            offset += 1;
        }

        if (offset >= bytes.byteLength) {
            return null;
        }

        const marker = bytes[offset++];

        if (marker === 0xd9 || marker === 0xda) {
            return null;
        }

        if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
            continue;
        }

        if (offset + 2 > bytes.byteLength) {
            return null;
        }

        const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];

        if (segmentLength < 2 || segmentLength > bytes.byteLength - offset) {
            return null;
        }

        if (isJpegStartOfFrame(marker)) {
            if (segmentLength < 7) {
                return null;
            }

            return {
                width: (bytes[offset + 5] << 8) | bytes[offset + 6],
                height: (bytes[offset + 3] << 8) | bytes[offset + 4],
            };
        }

        offset += segmentLength;
    }

    return null;
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | null {
    if (
        bytes.byteLength < 20 ||
        String.fromCharCode(...bytes.slice(0, 4)) !== "RIFF" ||
        String.fromCharCode(...bytes.slice(8, 12)) !== "WEBP"
    ) {
        return null;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 12;

    while (offset + 8 <= bytes.byteLength) {
        const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
        const length = view.getUint32(offset + 4, true);

        if (length > bytes.byteLength - offset - 8) {
            return null;
        }

        const dataOffset = offset + 8;

        if (type === "VP8X" && length >= 10) {
            return {
                width: uint24LittleEndian(bytes, dataOffset + 4) + 1,
                height: uint24LittleEndian(bytes, dataOffset + 7) + 1,
            };
        }

        if (
            type === "VP8 " &&
            length >= 10 &&
            bytes[dataOffset + 3] === 0x9d &&
            bytes[dataOffset + 4] === 0x01 &&
            bytes[dataOffset + 5] === 0x2a
        ) {
            return {
                width: view.getUint16(dataOffset + 6, true) & 0x3fff,
                height: view.getUint16(dataOffset + 8, true) & 0x3fff,
            };
        }

        if (type === "VP8L" && length >= 5 && bytes[dataOffset] === 0x2f) {
            return {
                width: 1 + bytes[dataOffset + 1] + ((bytes[dataOffset + 2] & 0x3f) << 8),
                height:
                    1 +
                    (bytes[dataOffset + 2] >> 6) +
                    (bytes[dataOffset + 3] << 2) +
                    ((bytes[dataOffset + 4] & 0x0f) << 10),
            };
        }

        offset += 8 + length + (length % 2);
    }

    return null;
}

function rasterDimensions(
    bytes: Uint8Array,
    mimeType: ImageSafety["mimeType"],
): ImageDimensions | null {
    if (mimeType === "image/gif") {
        return gifDimensions(bytes);
    }

    if (mimeType === "image/png") {
        return pngDimensions(bytes);
    }

    if (mimeType === "image/jpeg") {
        return jpegDimensions(bytes);
    }

    return webpDimensions(bytes);
}

export function assertSafeImageBytes(bytes: Uint8Array): ImageSafety {
    assertMediaByteLength(bytes.byteLength, MAX_IMAGE_BYTES);
    const mimeType = safeRasterMimeType(bytes);
    const dimensions = rasterDimensions(bytes, mimeType);

    if (!dimensions) {
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

    const frameRects =
        mimeType === "image/gif"
            ? gifFrameRects(bytes)
            : mimeType === "image/png"
              ? pngFrameRects(bytes)
              : mimeType === "image/webp"
                ? webpFrameRects(bytes)
                : [];

    if (
        (frameCount > 1 && frameRects.length === 0) ||
        (frameRects.length > 0 && frameRects.length !== frameCount)
    ) {
        throw new MediaLimitError("This animation has invalid frame metadata.");
    }

    validateFrameRects(frameRects, width, height);

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

const IMAGE_EXTENSIONS = new Map<string, string>([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["jpeg", "image/jpeg"],
    ["gif", "image/gif"],
    ["webp", "image/webp"],
]);

export function imageMimeTypeFromName(name: string): string | null {
    const extension = name.toLowerCase().split(".").pop() ?? "";

    return IMAGE_EXTENSIONS.get(extension) ?? null;
}

export function isImageUploadCandidate(file: File): boolean {
    return (
        file.type.toLowerCase().startsWith("image/") || imageMimeTypeFromName(file.name) !== null
    );
}

export function boundedMediaString(value: unknown, maximumLength = 4096): string {
    if (
        !isSafeNonNegativeInteger(maximumLength) ||
        typeof value !== "string" ||
        value.length > maximumLength
    ) {
        throw new MediaLimitError("The attachment metadata is too large.");
    }

    return value;
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(canonicalize);
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, nested]) => [key, canonicalize(nested)]),
        );
    }

    return value;
}

function base64Url(bytes: Uint8Array): string {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    if (typeof btoa === "function") {
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    throw new Error("This browser cannot encode encrypted media fingerprints safely.");
}

export async function encryptedMediaDigest(encryptedFile: unknown): Promise<string> {
    const source =
        encryptedFile && typeof encryptedFile === "object"
            ? (encryptedFile as Record<string, unknown>)
            : {};
    const key =
        source.key && typeof source.key === "object" ? (source.key as Record<string, unknown>) : {};
    const hashes =
        source.hashes && typeof source.hashes === "object"
            ? (source.hashes as Record<string, unknown>)
            : {};
    const keyOps = key.key_ops;

    if (
        !Array.isArray(keyOps) ||
        keyOps.length > 16 ||
        keyOps.some((value) => typeof value !== "string")
    ) {
        throw new MediaLimitError("The encrypted attachment key metadata is invalid.");
    }

    if (typeof key.ext !== "boolean") {
        throw new MediaLimitError("The encrypted attachment key metadata is invalid.");
    }

    const tuple = canonicalize({
        v: boundedMediaString(source.v, 32),
        url: boundedMediaString(source.url, 4096),
        key: {
            alg: boundedMediaString(key.alg, 128),
            ext: key.ext,
            key_ops: keyOps.map((value) => boundedMediaString(value, 128)),
            kty: boundedMediaString(key.kty, 128),
            k: boundedMediaString(key.k, 4096),
        },
        iv: boundedMediaString(source.iv, 256),
        hashes: { sha256: boundedMediaString(hashes.sha256, 256) },
    });
    const encoded = new TextEncoder().encode(JSON.stringify(tuple));
    const subtle = globalThis.crypto?.subtle;

    if (!subtle) {
        throw new Error("This browser cannot fingerprint encrypted media safely.");
    }

    return base64Url(new Uint8Array(await subtle.digest("SHA-256", encoded)));
}

export function canonicalMediaFileName(file: File, mimeType = file.type): string {
    const fallbackName = `sub-etha-${Date.now()}.${extensionForMime(mimeType)}`;
    const name = file.name && !file.name.startsWith("image.") ? file.name : fallbackName;

    return boundedMediaString(name, 255);
}

export async function normalizeMediaFile(file: File): Promise<File> {
    let mimeType = file.type.toLowerCase();

    if (!mimeType || mimeType === "application/octet-stream") {
        mimeType = imageMimeTypeFromName(file.name) ?? mimeType;
    }

    if (!mimeType) {
        mimeType = "application/octet-stream";
    }

    const name = canonicalMediaFileName(file, mimeType);

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
