import type { CSSProperties } from "react";
import { containImageSize } from "@/lib/image-viewer";
import { timelineYouTubePreviews, youtubePreviewLayout } from "@/lib/youtube-preview";
import type { TimelineItem } from "@/lib/matrix/types";

/*
 * How long a row carries its entrance marker. Slightly longer than the
 * animation itself so the last frame is never cut off on a busy commit.
 */
export const ENTER_ANIMATION_MS = 520;
export const REACTION_POP_MS = 700;
/*
 * Entrance tracking remembers which events it has already shown. The timeline
 * is windowed, so the ids outlive the rows; past this many the set is rebuilt
 * from what is actually in the window.
 */
export const KNOWN_ITEM_ID_LIMIT = 2_000;
export const NO_ENTERING_ITEMS: ReadonlySet<string> = new Set<string>();

export const TIMELINE_VIEWPORT_PADDING = { top: 0, bottom: 300 };

const TIMELINE_COMPACT_BREAKPOINT_PX = 720;
const TIMELINE_ESTIMATED_MEDIA_GUTTER_PX = 70;
const TIMELINE_MAX_ESTIMATED_MEDIA_WIDTH_PX = 520;
const TIMELINE_MOBILE_ACTION_ROW_HEIGHT_PX = 44;

export const TIMELINE_BOTTOM_TOLERANCE_PX = 2;

export function timelineEntranceIdentity(item: TimelineItem): string {
    const transactionId =
        item.event && typeof item.event.getTxnId === "function" ? item.event.getTxnId() : null;

    return transactionId ? `txn:${transactionId}` : `event:${item.id}`;
}

const AUTHOR_ACCENTS = [
    "var(--participant-steel)",
    "var(--participant-sage)",
    "var(--participant-orchid)",
    "var(--participant-clay)",
    "var(--participant-rose)",
] as const;

type AuthorAccentStyle = CSSProperties & {
    "--author-accent": string;
    "--reply-accent"?: string;
};

function authorAccent(senderId: string, own: boolean): string {
    if (own) {
        return "var(--ink)";
    }

    const localpart = senderId.startsWith("@")
        ? (senderId.slice(1).split(":", 1)[0] ?? senderId)
        : senderId;
    let hash = 0;

    for (let index = 0; index < localpart.length; index += 1) {
        hash = (hash * 31 + localpart.charCodeAt(index)) >>> 0;
    }

    return AUTHOR_ACCENTS[hash % AUTHOR_ACCENTS.length];
}

/*
 * A quoted excerpt is ruled in the hue of the person being quoted, so the reply
 * names its source before the text is read. The summary fallback carries its own
 * sender id for the same reason; without one the rule falls back to the author.
 */
export function getAuthorAccentStyle(
    item: TimelineItem,
    replyItem?: TimelineItem,
): AuthorAccentStyle {
    const style: AuthorAccentStyle = {
        "--author-accent": authorAccent(item.senderId, item.own),
    };
    const quoted = replyItem
        ? { senderId: replyItem.senderId, own: replyItem.own }
        : item.replySummary?.senderId
          ? { senderId: item.replySummary.senderId, own: false }
          : null;

    if (quoted) {
        style["--reply-accent"] = authorAccent(quoted.senderId, quoted.own);
    }

    return style;
}

export function timelineItemHasActions(item: TimelineItem): boolean {
    return (
        item.type !== "system" &&
        item.decryptionState === "ready" &&
        !item.redacted &&
        !item.sendingStatus
    );
}

export function estimateTimelineItemHeight(item: TimelineItem, viewportWidth: number): number {
    const compact = viewportWidth <= TIMELINE_COMPACT_BREAKPOINT_PX;
    const availableTextWidth = compact
        ? Math.max(180, viewportWidth - 116)
        : Math.min(680, Math.max(240, viewportWidth - 600));
    const approximateCharactersPerLine = Math.max(
        20,
        Math.floor(availableTextWidth / (compact ? 7.1 : 7.2)),
    );
    const estimatedTextLines = Math.max(
        1,
        item.body
            .split("\n")
            .filter((line) => line.length > 0)
            .reduce(
                (total, line) =>
                    total + Math.max(1, Math.ceil(line.length / approximateCharactersPerLine)),
                0,
            ),
    );
    /* The constant covers the row's fixed chrome: the rule above the block, its
       padding, the sender line, and the gap below. */
    const textHeight = (compact ? 68 : 80) + estimatedTextLines * (compact ? 25.2 : 27.52);
    const youtubePreviews = timelineYouTubePreviews(item);
    const youtubeHeight = youtubePreviewLayout(
        availableTextWidth,
        youtubePreviews.length,
    ).totalHeight;
    let estimate = textHeight;

    if (!item.redacted && (item.type === "image" || item.type === "video")) {
        const availableMediaWidth = compact
            ? availableTextWidth
            : Math.min(
                  TIMELINE_MAX_ESTIMATED_MEDIA_WIDTH_PX,
                  Math.max(240, viewportWidth - TIMELINE_ESTIMATED_MEDIA_GUTTER_PX),
              );
        const mediaWidth = item.media?.width;
        const mediaHeight = item.media?.height;
        let frameHeight: number;

        if (mediaWidth && mediaHeight && mediaWidth > 0 && mediaHeight > 0) {
            const contained = containImageSize(
                { width: mediaWidth, height: mediaHeight },
                { width: 620, height: 520 },
            );
            const displayedWidth = Math.min(contained.width, availableMediaWidth);

            frameHeight = displayedWidth * (mediaHeight / mediaWidth);
        } else {
            frameHeight = availableMediaWidth * 0.75;
        }

        estimate = textHeight + frameHeight + 8;
    } else if (!item.redacted && item.type === "audio") {
        estimate = compact ? 190 : 150;
    } else if (!item.redacted && item.type === "file") {
        estimate = compact ? 170 : 130;
    } else if (item.type === "notice" || item.type === "system") {
        estimate = compact ? 92 : 68;
    }

    estimate += youtubeHeight;

    if (compact && timelineItemHasActions(item)) {
        estimate += TIMELINE_MOBILE_ACTION_ROW_HEIGHT_PX;
    }

    if (item.replyTo) {
        estimate += compact ? 30 : 34;
    }

    if (item.reactions.length > 0) {
        estimate += compact ? 23 : 34;
    }

    return Math.round(estimate);
}

export function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).format(timestamp);
}

export function initialUnreadBoundaryId(
    items: readonly TimelineItem[],
    unreadCount: number,
): string | null {
    if (unreadCount <= 0 || items.length === 0) {
        return null;
    }

    return items[Math.max(0, items.length - unreadCount)]?.id ?? null;
}

export function formatSize(size?: number): string {
    if (!size) {
        return "File";
    }

    if (size < 1024) {
        return `${size} B`;
    }

    if (size < 1024 * 1024) {
        return `${Math.round(size / 1024)} KB`;
    }

    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function timelineVisualFrameStyle(item: TimelineItem): CSSProperties {
    const width = item.media?.width;
    const height = item.media?.height;

    if (!width || !height || width <= 0 || height <= 0) {
        return { width: "min(520px, 100%)", aspectRatio: "4 / 3" };
    }

    const size = containImageSize({ width, height }, { width: 620, height: 520 });

    return { width: `${size.width}px`, aspectRatio: `${width} / ${height}` };
}
