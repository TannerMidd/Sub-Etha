export const YOUTUBE_PREVIEW_MAX_WIDTH_PX = 480;
export const YOUTUBE_PREVIEW_ASPECT_RATIO = 4 / 3;
export const YOUTUBE_PREVIEW_METADATA_HEIGHT_PX = 44;
export const YOUTUBE_PREVIEW_GAP_PX = 8;
export const YOUTUBE_PREVIEW_LIST_MARGIN_PX = 8;
export const YOUTUBE_PREVIEW_MAX_COUNT = 3;
export const YOUTUBE_PREVIEW_SCAN_LIMIT = 16_384;
export const YOUTUBE_PREVIEW_RAW_TOKEN_LIMIT = 32;
export const YOUTUBE_PREVIEW_TOKEN_LIMIT = 2_048;
export const YOUTUBE_PREVIEW_FAILURE_CAPACITY = 256;

const YOUTUBE_HOSTS = new Set(["youtu.be", "youtube.com", "www.youtube.com", "m.youtube.com"]);
const YOUTUBE_QUERY_KEYS = new Set(["v", "t", "start", "list", "index", "si", "feature"]);
const YOUTUBE_QUERY_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const ASCII_WHITESPACE = new Set([9, 10, 11, 12, 13, 32]);
const EXPLICIT_TOKEN_DELIMITERS = new Set([
    '"',
    "'",
    "`",
    "<",
    ">",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    ",",
    ";",
    "!",
]);

export interface YouTubePreview {
    id: string;
    src: string;
    href: string;
}

export interface YouTubePreviewLayout {
    width: number;
    imageHeight: number;
    cardHeight: number;
    totalHeight: number;
    count: number;
}

export interface YouTubeTimelineItem {
    body: unknown;
    type?: unknown;
    decryptionState?: unknown;
    redacted?: unknown;
    media?: unknown;
    sendingStatus?: unknown;
}

function isAsciiWhitespace(character: string | undefined): boolean {
    return character !== undefined && ASCII_WHITESPACE.has(character.charCodeAt(0));
}

function isExplicitDelimiter(character: string | undefined): boolean {
    return character !== undefined && EXPLICIT_TOKEN_DELIMITERS.has(character);
}

function boundedBody(body: string): string {
    if (body.length <= YOUTUBE_PREVIEW_SCAN_LIMIT) {
        return body;
    }

    const slice = body.slice(0, YOUTUBE_PREVIEW_SCAN_LIMIT);

    if (
        isAsciiWhitespace(slice.at(-1)) ||
        isExplicitDelimiter(slice.at(-1)) ||
        isAsciiWhitespace(body[YOUTUBE_PREVIEW_SCAN_LIMIT]) ||
        isExplicitDelimiter(body[YOUTUBE_PREVIEW_SCAN_LIMIT])
    ) {
        return slice;
    }

    for (let index = slice.length - 1; index >= 0; index -= 1) {
        if (isAsciiWhitespace(slice[index])) {
            return slice.slice(0, index);
        }
    }

    return "";
}

function scanRawYouTubeTokens(body: string): string[] {
    const bounded = boundedBody(body);
    const tokens: string[] = [];
    let cursor = 0;

    while (cursor < bounded.length && tokens.length < YOUTUBE_PREVIEW_RAW_TOKEN_LIMIT) {
        const start = bounded.indexOf("https://", cursor);

        if (start < 0) {
            break;
        }

        const preceding = bounded[start - 1];

        if (
            preceding !== undefined &&
            !isAsciiWhitespace(preceding) &&
            !isExplicitDelimiter(preceding)
        ) {
            cursor = start + "https://".length;
            continue;
        }

        let end = start + "https://".length;

        while (
            end < bounded.length &&
            !isAsciiWhitespace(bounded[end]) &&
            !isExplicitDelimiter(bounded[end])
        ) {
            end += 1;
        }

        tokens.push(bounded.slice(start, end));
        cursor = Math.max(end, start + "https://".length);
    }

    return tokens;
}

function hasForbiddenRawCharacters(token: string): boolean {
    for (const character of token) {
        const code = character.charCodeAt(0);

        if (
            code < 0x20 ||
            code === 0x7f ||
            character === "\\" ||
            character === "%" ||
            character === "#" ||
            (code > 0x7f && /\s/u.test(character))
        ) {
            return true;
        }
    }

    return false;
}

function parseWatchQuery(query: string): string | null {
    if (!query) {
        return null;
    }

    const fields = query.split("&");
    const values = new Map<string, string>();

    for (const field of fields) {
        const equals = field.indexOf("=");

        if (equals <= 0 || equals !== field.lastIndexOf("=")) {
            return null;
        }

        const key = field.slice(0, equals);
        const value = field.slice(equals + 1);

        if (!YOUTUBE_QUERY_KEYS.has(key) || !YOUTUBE_QUERY_VALUE.test(value) || values.has(key)) {
            return null;
        }

        values.set(key, value);
    }

    const id = values.get("v");

    return id && YOUTUBE_VIDEO_ID.test(id) ? id : null;
}

function parseYouTubeToken(token: string): string | null {
    if (
        token.length > YOUTUBE_PREVIEW_TOKEN_LIMIT ||
        !token.startsWith("https://") ||
        hasForbiddenRawCharacters(token)
    ) {
        return null;
    }

    const authorityStart = "https://".length;
    const firstSlash = token.indexOf("/", authorityStart);
    const firstQuestion = token.indexOf("?", authorityStart);
    const authorityEnd =
        firstSlash < 0
            ? firstQuestion < 0
                ? token.length
                : firstQuestion
            : firstQuestion < 0
              ? firstSlash
              : Math.min(firstSlash, firstQuestion);
    const host = token.slice(authorityStart, authorityEnd);

    if (!YOUTUBE_HOSTS.has(host) || host.includes(":") || host.includes("@")) {
        return null;
    }

    const queryIndex = token.indexOf("?", authorityEnd);
    const pathEnd = queryIndex < 0 ? token.length : queryIndex;
    const path = token.slice(authorityEnd, pathEnd);
    const query = queryIndex < 0 ? null : token.slice(queryIndex + 1);
    const segments = path.split("/");

    if (
        !path.startsWith("/") ||
        segments.some(
            (segment, index) =>
                index > 0 && (segment === "" || segment === "." || segment === ".."),
        )
    ) {
        return null;
    }

    if (host === "youtu.be") {
        if (query !== null || segments.length !== 2 || !YOUTUBE_VIDEO_ID.test(segments[1] ?? "")) {
            return null;
        }

        return segments[1] ?? null;
    }

    if (query === null) {
        if (segments.length !== 3 || !["shorts", "embed", "live"].includes(segments[1] ?? "")) {
            return null;
        }

        return YOUTUBE_VIDEO_ID.test(segments[2] ?? "") ? (segments[2] ?? null) : null;
    }

    if (path !== "/watch") {
        return null;
    }

    return parseWatchQuery(query);
}

export function parseYouTubeVideoIds(body: unknown): string[] {
    if (typeof body !== "string") {
        return [];
    }

    const ids: string[] = [];
    const seen = new Set<string>();

    for (const token of scanRawYouTubeTokens(body)) {
        const id = parseYouTubeToken(token);

        if (!id || seen.has(id)) {
            continue;
        }

        seen.add(id);
        ids.push(id);

        if (ids.length >= YOUTUBE_PREVIEW_MAX_COUNT) {
            break;
        }
    }

    return ids;
}

export function youtubeThumbnailUrl(id: string): string {
    return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

export function youtubeWatchUrl(id: string): string {
    return `https://www.youtube.com/watch?v=${id}`;
}

export function isTimelineYouTubePreviewEligible(item: YouTubeTimelineItem): boolean {
    return !(
        !item ||
        typeof item.body !== "string" ||
        item.decryptionState !== "ready" ||
        item.redacted === true ||
        item.sendingStatus != null ||
        item.media != null ||
        (item.type !== "message" && item.type !== "notice")
    );
}

export function timelineYouTubePreviews(item: YouTubeTimelineItem): YouTubePreview[] {
    if (!isTimelineYouTubePreviewEligible(item)) {
        return [];
    }

    return parseYouTubeVideoIds(item.body).map((id) => ({
        id,
        src: youtubeThumbnailUrl(id),
        href: youtubeWatchUrl(id),
    }));
}

export function youtubePreviewLayout(
    availableMessageWidth: number,
    count: number,
): YouTubePreviewLayout {
    const boundedCount = Math.max(0, Math.min(YOUTUBE_PREVIEW_MAX_COUNT, Math.floor(count)));
    const width = Math.min(YOUTUBE_PREVIEW_MAX_WIDTH_PX, Math.max(0, availableMessageWidth));
    const imageHeight = width / YOUTUBE_PREVIEW_ASPECT_RATIO;
    const cardHeight = imageHeight + YOUTUBE_PREVIEW_METADATA_HEIGHT_PX;
    const totalHeight =
        boundedCount === 0
            ? 0
            : YOUTUBE_PREVIEW_LIST_MARGIN_PX +
              boundedCount * cardHeight +
              (boundedCount - 1) * YOUTUBE_PREVIEW_GAP_PX;

    return { width, imageHeight, cardHeight, totalHeight, count: boundedCount };
}

export class BoundedYouTubeThumbnailFailureStore {
    private readonly failed = new Set<string>();

    constructor(private readonly capacity = YOUTUBE_PREVIEW_FAILURE_CAPACITY) {}

    has(id: string): boolean {
        return this.failed.has(id);
    }

    markFailed(id: string): void {
        if (this.failed.has(id)) {
            return;
        }

        this.failed.add(id);

        while (this.failed.size > this.capacity) {
            const oldest = this.failed.values().next().value;

            if (oldest === undefined) {
                break;
            }

            this.failed.delete(oldest);
        }
    }

    mark(id: string): void {
        this.markFailed(id);
    }

    recordFailure(id: string): void {
        this.markFailed(id);
    }

    hasFailed(id: string): boolean {
        return this.has(id);
    }

    get size(): number {
        return this.failed.size;
    }

    ids(): string[] {
        return [...this.failed];
    }
}

export const youtubeThumbnailFailureStore = new BoundedYouTubeThumbnailFailureStore();
export const youtubeThumbnailFailures = youtubeThumbnailFailureStore;

// Compatibility aliases keep the parser contract discoverable to focused tests.
export const parseYoutubeVideoIds = parseYouTubeVideoIds;
export const youtubePreviewsForTimelineItem = timelineYouTubePreviews;
export const getYouTubePreviewLayout = youtubePreviewLayout;
