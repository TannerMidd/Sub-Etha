"use client";

import {
    Fragment,
    lazy,
    Suspense,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { Virtuoso } from "react-virtuoso";
import {
    CheckCheck,
    ChevronLeft,
    ChevronRight,
    CornerUpLeft,
    Download,
    FileText,
    LoaderCircle,
    Maximize2,
    Pencil,
    Play,
    RefreshCw,
    ShieldAlert,
    SmilePlus,
    Trash2,
    X,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import { MediaLimitError } from "@/lib/matrix/media";
import {
    clampViewerZoom,
    containImageSize,
    MAX_VIEWER_ZOOM,
    MIN_VIEWER_ZOOM,
    pinchViewerZoom,
    preserveScrollCenter,
    stepViewerZoom,
    type ViewerSize,
} from "@/lib/image-viewer";
import {
    isTimelineYouTubePreviewEligible,
    timelineYouTubePreviews,
    youtubePreviewLayout,
    youtubeThumbnailFailureStore,
    type YouTubePreview,
} from "@/lib/youtube-preview";
import { messageTextSegments } from "@/lib/matrix/message-text";
import type { MediaAsset, TimelineItem } from "@/lib/matrix/types";
import {
    classifyTimelineChange,
    shouldFollowTimelineChange,
    transitionTimelineScrollMode,
    type TimelineIdentity,
    type TimelineScrollEvent,
    type TimelineScrollMode,
} from "@/lib/timeline-scroll";
import { SkeletonBar, SkeletonGroup } from "./Skeleton";
import { classes } from "../styles/appStyles";

const EmojiPickerPanel = lazy(() =>
    import("./EmojiPickerPanel").then((module) => ({ default: module.EmojiPickerPanel })),
);
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
/*
 * How long a row carries its entrance marker. Slightly longer than the
 * animation itself so the last frame is never cut off on a busy commit.
 */
const ENTER_ANIMATION_MS = 520;
const REACTION_POP_MS = 700;
/*
 * Entrance tracking remembers which events it has already shown. The timeline
 * is windowed, so the ids outlive the rows; past this many the set is rebuilt
 * from what is actually in the window.
 */
const KNOWN_ITEM_ID_LIMIT = 2_000;
const NO_ENTERING_ITEMS: ReadonlySet<string> = new Set<string>();

function timelineEntranceIdentity(item: TimelineItem): string {
    const transactionId =
        item.event && typeof item.event.getTxnId === "function" ? item.event.getTxnId() : null;

    return transactionId ? `txn:${transactionId}` : `event:${item.id}`;
}

const TIMELINE_VIEWPORT_PADDING = { top: 0, bottom: 300 };
const TIMELINE_COMPACT_BREAKPOINT_PX = 720;
const TIMELINE_ESTIMATED_MEDIA_GUTTER_PX = 70;
const TIMELINE_MAX_ESTIMATED_MEDIA_WIDTH_PX = 520;
const TIMELINE_MOBILE_ACTION_ROW_HEIGHT_PX = 44;
const HISTORY_ANCHOR_MIN_SETTLE_MS = 120;
// Slow devices can continue delivering Virtuoso height corrections well after
// the first stable frames. Keep the anchor live long enough to absorb those
// late measurements; any real user gesture still cancels or defers restoration.
const HISTORY_ANCHOR_MAX_SETTLE_MS = 1_500;
const HISTORY_ANCHOR_STABLE_FRAMES = 4;
const HISTORY_COMMIT_GRACE_FRAMES = 4;
const HISTORY_COMMIT_GRACE_MAX_MS = 250;
// Trackpad and wheel bursts can arrive farther apart on a busy or low-power
// device. Do not hand geometry correction back to the list between events that
// still belong to the same gesture.
const USER_SCROLL_END_DELAY_MS = 600;
const TIMELINE_BOTTOM_TOLERANCE_PX = 2;
const NEWEST_MESSAGE_MIN_SETTLE_MS = 200;
const NEWEST_MESSAGE_MAX_SETTLE_MS = 2_000;
const NEWEST_MESSAGE_STABLE_FRAMES = 3;

type UserScrollDirection = -1 | 0 | 1;

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
function getAuthorAccentStyle(item: TimelineItem, replyItem?: TimelineItem): AuthorAccentStyle {
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

function timelineItemHasActions(item: TimelineItem): boolean {
    return (
        item.type !== "system" &&
        item.decryptionState === "ready" &&
        !item.redacted &&
        !item.sendingStatus
    );
}

function estimateTimelineItemHeight(item: TimelineItem, viewportWidth: number): number {
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

interface TimelineVirtuosoContext {
    loadingHistory: boolean;
    hasMoreHistory: boolean;
    firstTimestamp: number | null;
    requestEarlierHistory: () => void;
}

interface TimelineHistoryAnchor {
    id: string;
    index: number;
    target: "event" | "item";
    top: number;
}

/*
 * The rhythm of the placeholder rows. Uneven line lengths, and rows that vary
 * between one body line and two, read as a conversation rather than as a table;
 * an even stack of identical bars reads as a loading widget, which is the thing
 * a skeleton exists to avoid.
 */
const TIMELINE_SKELETON_ROWS: Array<{ body: string; second: string | null }> = [
    { body: "88%", second: "54%" },
    { body: "62%", second: null },
    { body: "94%", second: "71%" },
    { body: "48%", second: null },
    { body: "80%", second: "44%" },
];

function TimelineSkeletonRow({
    author,
    body,
    second = null,
}: {
    author: string;
    body: string;
    second?: string | null;
}) {
    return (
        <div className={classes("timeline-skeleton__row")}>
            <SkeletonBar width="32px" height={10} style={{ marginTop: 20 }} />
            <div className={classes("timeline-skeleton__main")}>
                <span className={classes("timeline-skeleton__marker")} />
                <SkeletonBar width={author} height={11} />
                <SkeletonBar width={body} height={12} style={{ marginTop: 15 }} />
                {second ? (
                    <SkeletonBar width={second} height={12} style={{ marginTop: 10 }} />
                ) : null}
            </div>
        </div>
    );
}

/*
 * Rendered inside `.timeline` so the placeholder inherits the frame's lane
 * widths and its vertical axis. The rows then occupy the geometry the real
 * messages will, which is what lets the conversation resolve without the page
 * relaying out around it. Exported because the shell shows the same shape
 * before a room has been chosen at all.
 */
export function TimelineSkeleton() {
    return (
        <div className={classes("timeline")} aria-label="Room messages" aria-busy="true">
            <SkeletonGroup label="Loading messages…" className="timeline-skeleton">
                {TIMELINE_SKELETON_ROWS.map((row) => (
                    <TimelineSkeletonRow
                        key={row.body}
                        author="78px"
                        body={row.body}
                        second={row.second}
                    />
                ))}
            </SkeletonGroup>
        </div>
    );
}

function TimelineHistoryHeader({ context }: { context: TimelineVirtuosoContext }) {
    const historyControl = context.hasMoreHistory ? (
        <div className={classes("history-loader")} role="status" aria-live="polite">
            <button
                type="button"
                onClick={context.requestEarlierHistory}
                disabled={context.loadingHistory}
            >
                {context.loadingHistory ? (
                    <LoaderCircle className={classes("spin")} aria-hidden="true" />
                ) : (
                    <RefreshCw aria-hidden="true" />
                )}
                {context.loadingHistory
                    ? "Consulting earlier transmissions…"
                    : "Load earlier transmissions"}
            </button>
        </div>
    ) : (
        <div className={classes("history-loader")} role="status" aria-live="polite">
            <span className={classes("history-loader__status")}>
                Beginning of recorded transmissions
            </span>
        </div>
    );

    /*
     * The reference draws placeholder rows here while earlier history loads.
     * This timeline cannot: prepending must not move the reader (see the
     * windowing rule in docs/architecture.md), and rows added to the header
     * grow it by their own height at exactly the moment the anchor is holding
     * the viewport still — which pushes the reader down instead. The control
     * below already reports the request without changing any geometry, so the
     * placeholder is deliberately omitted rather than fought into place.
     */
    return (
        <>
            {historyControl}
            {context.firstTimestamp !== null ? (
                <DayDivider timestamp={context.firstTimestamp} />
            ) : null}
        </>
    );
}

function TimelineFooter() {
    return <div className={classes("timeline-footer-inset")} aria-hidden="true" />;
}

const TIMELINE_COMPONENTS = {
    Header: TimelineHistoryHeader,
    Footer: TimelineFooter,
};

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    }).format(timestamp);
}

function startOfDay(date: Date): number {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/*
 * The day label shares the narrow lane the timestamps sit in, so it has to read
 * at a timestamp's width — the long weekday form is nearly twice the lane and
 * wraps into a stack. Named days carry the recent past, and everything older
 * falls back to a short date that keeps the year only when it is not the
 * current one. `formatFullDate` still supplies the complete date for the title
 * and the machine-readable value.
 */
function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const today = new Date();
    const elapsedDays = Math.round((startOfDay(today) - startOfDay(date)) / 86_400_000);

    if (elapsedDays === 0) {
        return "Today";
    }

    if (elapsedDays === 1) {
        return "Yesterday";
    }

    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    }).format(timestamp);
}

function formatFullDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
    }).format(timestamp);
}

function initialUnreadBoundaryId(
    items: readonly TimelineItem[],
    unreadCount: number,
): string | null {
    if (unreadCount <= 0 || items.length === 0) {
        return null;
    }

    return items[Math.max(0, items.length - unreadCount)]?.id ?? null;
}

function formatSize(size?: number): string {
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

function timelineVisualFrameStyle(item: TimelineItem): CSSProperties {
    const width = item.media?.width;
    const height = item.media?.height;

    if (!width || !height || width <= 0 || height <= 0) {
        return { width: "min(520px, 100%)", aspectRatio: "4 / 3" };
    }

    const size = containImageSize({ width, height }, { width: 620, height: 520 });

    return { width: `${size.width}px`, aspectRatio: `${width} / ${height}` };
}

function useTimelineMedia(item: TimelineItem, service: MatrixService, retryToken = 0) {
    const requestKey = `${item.id}:${retryToken}`;
    const [result, setResult] = useState<{
        key: string;
        asset: MediaAsset | null;
        error: string | null;
        retryable: boolean;
    } | null>(null);

    useEffect(() => {
        let active = true;

        if (!item.media) {
            return () => {
                active = false;
            };
        }

        void service
            .getMediaAsset(item.media, {
                cacheKey: item.id,
                expectedKind: ["image", "video", "audio"].includes(item.type)
                    ? (item.type as "image" | "video" | "audio")
                    : "file",
            })
            .then((value) => {
                if (active) {
                    setResult({ key: requestKey, asset: value, error: null, retryable: true });
                }
            })
            .catch((cause) => {
                if (active) {
                    setResult({
                        key: requestKey,
                        asset: null,
                        error:
                            cause instanceof Error ? cause.message : "Media could not be loaded.",
                        retryable: !(cause instanceof MediaLimitError),
                    });
                }
            });

        return () => {
            active = false;
        };
    }, [item.id, item.media, item.type, requestKey, service]);

    return result?.key === requestKey ? result : { asset: null, error: null, retryable: true };
}

function AnimatedImage({
    item,
    service,
    asset,
    className,
    loading = "lazy",
    onImageLoad,
    onOpen,
}: {
    item: TimelineItem;
    service: MatrixService;
    asset: MediaAsset;
    className?: string;
    loading?: "eager" | "lazy";
    onImageLoad?: (size: ViewerSize) => void;
    onOpen?: (opener: HTMLElement) => void;
}) {
    const [playOverride, setPlayOverride] = useState(false);
    const [poster, setPoster] = useState<string | null>(null);
    const playing = playOverride;

    useEffect(() => {
        let active = true;

        if (!asset.animated || !item.media) {
            return () => {
                active = false;
            };
        }

        void service.getGifPoster(item.media, item.id).then((url) => {
            if (active) {
                setPoster(url);
            }
        });

        return () => {
            active = false;
        };
    }, [asset.animated, item.id, item.media, service]);

    return (
        <span
            className={classes(`animated-image${className ? ` ${className}` : ""}`)}
            role={onOpen ? "button" : undefined}
            tabIndex={onOpen ? 0 : undefined}
            aria-label={onOpen ? `View ${item.body || "image"}` : undefined}
            onClick={onOpen ? (event) => onOpen(event.currentTarget) : undefined}
            onKeyDown={
                onOpen
                    ? (event) => {
                          if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onOpen(event.currentTarget);
                          }
                      }
                    : undefined
            }
        >
            {/* eslint-disable-next-line @next/next/no-img-element -- Decrypted Matrix object URL. */}
            <img
                src={!asset.animated || playing ? asset.url : (poster ?? undefined)}
                alt={item.body || `Image from ${item.senderName}`}
                width={item.media?.width}
                height={item.media?.height}
                draggable={false}
                loading={loading}
                onLoad={(event) =>
                    onImageLoad?.({
                        width: event.currentTarget.naturalWidth,
                        height: event.currentTarget.naturalHeight,
                    })
                }
            />
            {asset.animated && !playing ? (
                <button
                    type="button"
                    className={classes("gif-play")}
                    onClick={(event) => {
                        event.stopPropagation();
                        setPlayOverride(true);
                    }}
                >
                    <Play />
                    Play GIF
                </button>
            ) : null}
        </span>
    );
}

function MediaAttachment({
    item,
    service,
    onOpen,
}: {
    item: TimelineItem;
    service: MatrixService;
    onOpen: (item: TimelineItem, opener: HTMLElement) => void;
}) {
    const [retryToken, setRetryToken] = useState(0);
    const { asset, error, retryable } = useTimelineMedia(item, service, retryToken);
    const visual = item.type === "image" || item.type === "video";
    const visualFrameStyle = visual ? timelineVisualFrameStyle(item) : undefined;
    const visualFrameClass = item.type === "video" ? "video-attachment-frame" : "image-attachment";

    const retry = () => {
        if (item.media) {
            service.invalidateMedia(item.media, item.id);
        }

        setRetryToken((value) => value + 1);
    };

    if (error) {
        if (visual) {
            return (
                <div
                    className={classes(`${visualFrameClass} media-frame--reserved`)}
                    style={visualFrameStyle}
                >
                    <div className={classes("media-error media-error--visual")}>
                        <ShieldAlert aria-hidden="true" />
                        <span>{error}</span>
                        {retryable ? (
                            <button type="button" onClick={retry}>
                                <RefreshCw />
                                Retry
                            </button>
                        ) : null}
                    </div>
                </div>
            );
        }

        return (
            <div className={classes(`media-error media-error--${item.type}`)}>
                <ShieldAlert aria-hidden="true" />
                <span>{error}</span>
                {retryable ? (
                    <button type="button" onClick={retry}>
                        <RefreshCw />
                        Retry
                    </button>
                ) : null}
            </div>
        );
    }

    if (!asset) {
        /*
         * The frame already reserves the picture's real dimensions, so the
         * placeholder fills it rather than centring a spinner inside it: the
         * image lands in exactly the space its skeleton held, and the timeline
         * never reflows around it.
         */
        if (visual) {
            return (
                <div
                    className={classes(`${visualFrameClass} media-frame--reserved`)}
                    style={visualFrameStyle}
                >
                    <div
                        className={classes(
                            "media-loading media-loading--visual media-loading--skeleton",
                        )}
                        role="status"
                    >
                        <i className={classes("skeleton")} aria-hidden="true" />
                        <span className={classes("sr-only")}>Decrypting attachment…</span>
                    </div>
                </div>
            );
        }

        return (
            <div className={classes(`media-loading media-loading--${item.type}`)}>
                <LoaderCircle className={classes("spin")} aria-hidden="true" /> Decrypting
                attachment…
            </div>
        );
    }

    if (item.type === "image") {
        return (
            <div
                className={classes("image-attachment media-frame--reserved")}
                style={visualFrameStyle}
            >
                <AnimatedImage
                    item={item}
                    service={service}
                    asset={asset}
                    onOpen={(opener) => onOpen(item, opener)}
                />
                <span className={classes("image-attachment__hint")} aria-hidden="true">
                    <Maximize2 />
                    View
                </span>
            </div>
        );
    }

    if (item.type === "video") {
        // Matrix attachments do not include a caption track URL.

        return (
            <div
                className={classes("video-attachment-frame media-frame--reserved")}
                style={visualFrameStyle}
            >
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video
                    className={classes("video-attachment")}
                    src={asset.url}
                    controls
                    preload="metadata"
                />
            </div>
        );
    }

    if (item.type === "audio") {
        // Matrix attachments do not include a caption track URL.
        return (
            // eslint-disable-next-line jsx-a11y/media-has-caption
            <audio
                className={classes("audio-attachment")}
                src={asset.url}
                controls
                preload="metadata"
            />
        );
    }

    return (
        <a href={asset.url} download={item.body} className={classes("file-attachment")}>
            <span>
                <FileText aria-hidden="true" />
            </span>
            <span>
                <strong>{item.body}</strong>
                <small>{formatSize(item.media?.size)}</small>
            </span>
            <Download aria-hidden="true" />
        </a>
    );
}

function ReactionPicker({
    item,
    service,
    onClose,
}: {
    item: TimelineItem;
    service: MatrixService;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const dismiss = (event: PointerEvent) => {
            if (!ref.current?.contains(event.target as Node)) {
                onClose();
            }
        };

        const escape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };

        document.addEventListener("pointerdown", dismiss);
        window.addEventListener("keydown", escape);

        return () => {
            document.removeEventListener("pointerdown", dismiss);
            window.removeEventListener("keydown", escape);
        };
    }, [onClose]);

    const choose = (emoji: string) => {
        void service.toggleReaction(item.id, emoji);
        onClose();
    };

    return (
        <div
            ref={ref}
            className={classes("reaction-picker")}
            data-swipe-lock
            role="dialog"
            aria-label={`React to message from ${item.senderName}`}
        >
            <div className={classes("quick-reactions")}>
                {QUICK_REACTIONS.map((emoji) => (
                    <button type="button" key={emoji} onClick={() => choose(emoji)}>
                        {emoji}
                    </button>
                ))}
            </div>
            <Suspense
                fallback={
                    <div className={classes("emoji-loading")}>
                        <LoaderCircle className={classes("spin")} /> Indexing pictograms…
                    </div>
                }
            >
                <EmojiPickerPanel onSelect={choose} compact />
            </Suspense>
        </div>
    );
}

interface ViewerScrollMetrics {
    left: number;
    top: number;
    clientWidth: number;
    clientHeight: number;
    scrollWidth: number;
    scrollHeight: number;
}

interface ViewerDragState {
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
}

interface ViewerPointerState {
    pointerId: number;
    clientX: number;
    clientY: number;
    startX: number;
    startY: number;
}

interface ViewerPinchState {
    startDistance: number;
    startZoom: number;
}

function viewerPointerDistance(first: ViewerPointerState, second: ViewerPointerState): number {
    return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function readViewerScrollMetrics(stage: HTMLDivElement): ViewerScrollMetrics {
    return {
        left: stage.scrollLeft,
        top: stage.scrollTop,
        clientWidth: stage.clientWidth,
        clientHeight: stage.clientHeight,
        scrollWidth: stage.scrollWidth,
        scrollHeight: stage.scrollHeight,
    };
}

function initialImageSize(item: TimelineItem): ViewerSize {
    return {
        width: item.media?.width ?? 0,
        height: item.media?.height ?? 0,
    };
}

function Lightbox({
    items,
    selectedId,
    service,
    onSelect,
    onClose,
}: {
    items: TimelineItem[];
    selectedId: string;
    service: MatrixService;
    onSelect: (id: string) => void;
    onClose: () => void;
}) {
    const index = Math.max(
        0,
        items.findIndex((candidate) => candidate.id === selectedId),
    );
    const item = items[index];
    const [zoom, setZoom] = useState(MIN_VIEWER_ZOOM);
    const [retryToken, setRetryToken] = useState(0);
    const [naturalSize, setNaturalSize] = useState<ViewerSize>(() => initialImageSize(item));
    const [viewportSize, setViewportSize] = useState<ViewerSize>({ width: 0, height: 0 });
    const [dragging, setDragging] = useState(false);
    const { asset, error } = useTimelineMedia(item, service, retryToken);
    const panel = useRef<HTMLDivElement>(null);
    const stage = useRef<HTMLDivElement>(null);
    const closeButton = useRef<HTMLButtonElement>(null);
    const pendingCenter = useRef<ViewerScrollMetrics | null>(null);
    const dragState = useRef<ViewerDragState | null>(null);
    const activePointers = useRef<Map<number, ViewerPointerState>>(new Map());
    const pinchState = useRef<ViewerPinchState | null>(null);
    const zoomRef = useRef(zoom);
    const titleId = useId();
    const metadataId = useId();
    const fittedSize = useMemo(
        () => containImageSize(naturalSize, viewportSize),
        [naturalSize, viewportSize],
    );
    const canvasSize = {
        width: fittedSize.width * zoom,
        height: fittedSize.height * zoom,
    };
    const canPan = zoom > MIN_VIEWER_ZOOM;
    const zoomPercent = Math.round(zoom * 100);

    const updateZoom = useCallback((nextZoom: number) => {
        const clamped = clampViewerZoom(nextZoom);
        const currentZoom = zoomRef.current;

        if (clamped === currentZoom) {
            return;
        }

        if (stage.current) {
            pendingCenter.current = readViewerScrollMetrics(stage.current);
        }

        zoomRef.current = clamped;
        setZoom(clamped);
    }, []);

    const finishPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
        if (dragState.current?.pointerId !== event.pointerId) {
            return;
        }

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }

        dragState.current = null;
        setDragging(false);
    }, []);

    const clearViewerGesture = useCallback(() => {
        const currentStage = stage.current;

        if (currentStage) {
            for (const pointerId of activePointers.current.keys()) {
                if (currentStage.hasPointerCapture(pointerId)) {
                    currentStage.releasePointerCapture(pointerId);
                }
            }
        }

        activePointers.current.clear();
        pinchState.current = null;
        dragState.current = null;
    }, []);

    const resetViewerGesture = useCallback(() => {
        clearViewerGesture();
        setDragging(false);
    }, [clearViewerGesture]);

    const move = (direction: number) => {
        if (items.length < 2) {
            return;
        }

        onSelect(items[(index + direction + items.length) % items.length].id);
    };

    useEffect(() => {
        closeButton.current?.focus();
        const previousOverflow = document.body.style.overflow;

        document.body.style.overflow = "hidden";

        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, []);

    useEffect(() => {
        zoomRef.current = zoom;
    }, [zoom]);

    useEffect(() => {
        clearViewerGesture();

        return clearViewerGesture;
    }, [clearViewerGesture, selectedId]);

    useLayoutEffect(() => {
        const currentStage = stage.current;

        if (!currentStage) {
            return;
        }

        const updateViewport = () => {
            const style = window.getComputedStyle(currentStage);
            const horizontalPadding =
                Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
            const verticalPadding =
                Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
            const next = {
                width: Math.max(0, currentStage.clientWidth - horizontalPadding),
                height: Math.max(0, currentStage.clientHeight - verticalPadding),
            };

            setViewportSize((current) =>
                Math.abs(current.width - next.width) < 0.5 &&
                Math.abs(current.height - next.height) < 0.5
                    ? current
                    : next,
            );
        };

        updateViewport();

        if (typeof ResizeObserver === "undefined") {
            window.addEventListener("resize", updateViewport);

            return () => window.removeEventListener("resize", updateViewport);
        }

        const observer = new ResizeObserver(updateViewport);

        observer.observe(currentStage);

        return () => observer.disconnect();
    }, []);

    useLayoutEffect(() => {
        const currentStage = stage.current;
        const previous = pendingCenter.current;

        if (!currentStage || !previous) {
            return;
        }

        currentStage.scrollLeft = preserveScrollCenter(
            previous.left,
            previous.clientWidth,
            previous.scrollWidth,
            currentStage.scrollWidth,
        );
        currentStage.scrollTop = preserveScrollCenter(
            previous.top,
            previous.clientHeight,
            previous.scrollHeight,
            currentStage.scrollHeight,
        );
        pendingCenter.current = null;
    }, [canvasSize.height, canvasSize.width, zoom]);

    useEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) {
                return;
            }

            if (event.key === "Escape") {
                onClose();
            } else if (
                (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
                items.length > 1
            ) {
                event.preventDefault();
                const direction = event.key === "ArrowLeft" ? -1 : 1;

                onSelect(items[(index + direction + items.length) % items.length].id);
            } else if (event.key === "+" || event.key === "=") {
                event.preventDefault();
                updateZoom(stepViewerZoom(zoom, 1));
            } else if (event.key === "-") {
                event.preventDefault();
                updateZoom(stepViewerZoom(zoom, -1));
            } else if (event.key === "0") {
                event.preventDefault();
                updateZoom(MIN_VIEWER_ZOOM);
            } else if (event.key === "Tab") {
                const focusable = panel.current?.querySelectorAll<HTMLElement>(
                    "button:not([disabled]), a[href]",
                );

                if (!focusable?.length) {
                    return;
                }

                const first = focusable[0];
                const last = focusable[focusable.length - 1];

                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };

        window.addEventListener("keydown", keydown);

        return () => window.removeEventListener("keydown", keydown);
    }, [index, items, onClose, onSelect, updateZoom, zoom]);

    if (!item) {
        return null;
    }

    return (
        <div
            className={classes("lightbox")}
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div
                ref={panel}
                className={classes("lightbox__panel")}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={metadataId}
            >
                <header className={classes("lightbox__header")}>
                    <div className={classes("lightbox__identity")}>
                        <strong id={titleId}>{item.body || "Image"}</strong>
                        <span id={metadataId}>
                            {item.senderName} · {formatTime(item.timestamp)}
                        </span>
                    </div>
                    <div className={classes("lightbox__tools")} aria-label="Image controls">
                        <button
                            type="button"
                            className={classes(
                                `lightbox__tool lightbox__fit${zoom === MIN_VIEWER_ZOOM ? " is-active" : ""}`,
                            )}
                            onClick={() => updateZoom(MIN_VIEWER_ZOOM)}
                            aria-label="Fit image to viewer"
                            aria-pressed={zoom === MIN_VIEWER_ZOOM}
                            title="Fit image (0)"
                        >
                            <Maximize2 aria-hidden="true" />
                            <span className={classes("lightbox__tool-label")}>Fit</span>
                        </button>
                        <div
                            className={classes("lightbox__zoom-controls")}
                            role="group"
                            aria-label="Zoom controls"
                        >
                            <button
                                type="button"
                                onClick={() => updateZoom(stepViewerZoom(zoom, -1))}
                                disabled={zoom <= MIN_VIEWER_ZOOM}
                                aria-label="Zoom out"
                                title="Zoom out (-)"
                            >
                                <ZoomOut aria-hidden="true" />
                            </button>
                            <span
                                className={classes("lightbox__zoom-value")}
                                role="status"
                                aria-live="polite"
                                aria-atomic="true"
                            >
                                {zoomPercent}%
                            </span>
                            <button
                                type="button"
                                onClick={() => updateZoom(stepViewerZoom(zoom, 1))}
                                disabled={zoom >= MAX_VIEWER_ZOOM}
                                aria-label="Zoom in"
                                title="Zoom in (+)"
                            >
                                <ZoomIn aria-hidden="true" />
                            </button>
                        </div>
                        {asset ? (
                            <a
                                className={classes("lightbox__tool")}
                                href={asset.url}
                                download={item.body || "matrix-image"}
                                aria-label="Download image"
                                title="Download image"
                            >
                                <Download aria-hidden="true" />
                                <span className={classes("lightbox__tool-label")}>Download</span>
                            </a>
                        ) : null}
                        <button
                            ref={closeButton}
                            type="button"
                            className={classes("lightbox__tool")}
                            onClick={onClose}
                            aria-label="Close image viewer"
                            title="Close image viewer"
                        >
                            <X aria-hidden="true" />
                            <span className={classes("lightbox__tool-label")}>Close</span>
                        </button>
                    </div>
                </header>
                <div
                    ref={stage}
                    className={classes(
                        `lightbox__stage${canPan ? " is-pannable" : ""}${dragging ? " is-dragging" : ""}`,
                    )}
                    onPointerDown={(event) => {
                        if (
                            event.button !== 0 ||
                            (event.target as HTMLElement).closest("button, a")
                        ) {
                            return;
                        }

                        if (event.pointerType === "touch") {
                            const pointer = {
                                pointerId: event.pointerId,
                                clientX: event.clientX,
                                clientY: event.clientY,
                                startX: event.clientX,
                                startY: event.clientY,
                            };

                            activePointers.current.set(event.pointerId, pointer);
                            event.currentTarget.setPointerCapture(event.pointerId);

                            if (activePointers.current.size === 2) {
                                const [first, second] = [...activePointers.current.values()];

                                dragState.current = null;
                                pinchState.current = {
                                    startDistance: viewerPointerDistance(first, second),
                                    startZoom: zoomRef.current,
                                };
                                setDragging(false);
                            }

                            event.preventDefault();

                            return;
                        }

                        if (!canPan) {
                            return;
                        }

                        dragState.current = {
                            pointerId: event.pointerId,
                            startX: event.clientX,
                            startY: event.clientY,
                            scrollLeft: event.currentTarget.scrollLeft,
                            scrollTop: event.currentTarget.scrollTop,
                        };
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDragging(true);
                        event.preventDefault();
                    }}
                    onPointerMove={(event) => {
                        if (event.pointerType === "touch") {
                            const pointer = activePointers.current.get(event.pointerId);

                            if (!pointer) {
                                return;
                            }

                            pointer.clientX = event.clientX;
                            pointer.clientY = event.clientY;

                            if (activePointers.current.size >= 2) {
                                const [first, second] = [...activePointers.current.values()];
                                const pinch = pinchState.current;

                                if (pinch) {
                                    updateZoom(
                                        pinchViewerZoom(
                                            pinch.startZoom,
                                            pinch.startDistance,
                                            viewerPointerDistance(first, second),
                                        ),
                                    );
                                }

                                event.preventDefault();

                                return;
                            }

                            if (canPan && !dragState.current) {
                                dragState.current = {
                                    pointerId: event.pointerId,
                                    startX: pointer.startX,
                                    startY: pointer.startY,
                                    scrollLeft: event.currentTarget.scrollLeft,
                                    scrollTop: event.currentTarget.scrollTop,
                                };
                                setDragging(true);
                            }
                        }

                        const drag = dragState.current;

                        if (!drag || drag.pointerId !== event.pointerId) {
                            return;
                        }

                        event.currentTarget.scrollLeft =
                            drag.scrollLeft - (event.clientX - drag.startX);
                        event.currentTarget.scrollTop =
                            drag.scrollTop - (event.clientY - drag.startY);
                    }}
                    onPointerUp={(event) => {
                        if (event.pointerType === "touch") {
                            activePointers.current.delete(event.pointerId);
                            pinchState.current = null;

                            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                event.currentTarget.releasePointerCapture(event.pointerId);
                            }

                            if (activePointers.current.size === 0) {
                                dragState.current = null;
                                setDragging(false);
                            } else if (dragState.current?.pointerId === event.pointerId) {
                                dragState.current = null;
                                setDragging(false);
                            }

                            return;
                        }

                        finishPan(event);
                    }}
                    onPointerCancel={(event) => {
                        if (event.pointerType === "touch") {
                            resetViewerGesture();

                            return;
                        }

                        finishPan(event);
                    }}
                    onLostPointerCapture={resetViewerGesture}
                >
                    {error ? (
                        <div className={classes("lightbox__error")}>
                            <ShieldAlert />
                            <strong>Image unavailable</strong>
                            <span>{error}</span>
                            <button
                                type="button"
                                onClick={() => {
                                    if (item.media) {
                                        service.invalidateMedia(item.media, item.id);
                                    }

                                    setRetryToken((value) => value + 1);
                                }}
                            >
                                <RefreshCw />
                                Retry
                            </button>
                        </div>
                    ) : null}
                    {!asset && !error ? (
                        <div className={classes("lightbox__loading")}>
                            <LoaderCircle className={classes("spin")} />
                            Decrypting the full transmission…
                        </div>
                    ) : null}
                    {asset ? (
                        <div
                            className={classes("lightbox__canvas")}
                            style={{ width: canvasSize.width, height: canvasSize.height }}
                        >
                            <AnimatedImage
                                item={item}
                                service={service}
                                asset={asset}
                                className={classes("lightbox__image")}
                                loading="eager"
                                onImageLoad={(size) => setNaturalSize(size)}
                            />
                        </div>
                    ) : null}
                </div>
                {items.length > 1 ? (
                    <>
                        <button
                            type="button"
                            className={classes("lightbox__previous")}
                            onClick={() => move(-1)}
                            aria-label="Previous image"
                        >
                            <ChevronLeft />
                        </button>
                        <button
                            type="button"
                            className={classes("lightbox__next")}
                            onClick={() => move(1)}
                            aria-label="Next image"
                        >
                            <ChevronRight />
                        </button>
                    </>
                ) : null}
            </div>
        </div>
    );
}

function DayDivider({ timestamp }: { timestamp: number }) {
    return (
        <div className={classes("day-divider")} role="separator">
            <time dateTime={new Date(timestamp).toISOString()} title={formatFullDate(timestamp)}>
                {formatDate(timestamp)}
            </time>
        </div>
    );
}

function PlainMessageBody({ body }: { body: string }) {
    const paragraphs = useMemo(
        () => body.split(/\n{2,}/).map((paragraph) => messageTextSegments(paragraph)),
        [body],
    );

    return (
        <div className={classes("message-body")}>
            {paragraphs.map((segments, paragraphIndex) => (
                <p key={paragraphIndex}>
                    {segments.map((segment, segmentIndex) =>
                        segment.href ? (
                            <a
                                key={`${segment.href}-${segmentIndex}`}
                                href={segment.href}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {segment.text}
                            </a>
                        ) : (
                            <Fragment key={segmentIndex}>{segment.text}</Fragment>
                        ),
                    )}
                </p>
            ))}
        </div>
    );
}

function FormattedMessageBody({ html }: { html: NonNullable<TimelineItem["formattedBody"]> }) {
    const bodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const root = bodyRef.current;

        if (!root) {
            return;
        }

        const cleanups: Array<() => void> = [];

        for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
        }

        for (const element of root.querySelectorAll<HTMLElement>(
            "[data-mx-color], [data-mx-bg-color]",
        )) {
            const foreground = element.dataset.mxColor;
            const background = element.dataset.mxBgColor;

            if (foreground && /^#[0-9a-f]{6}$/i.test(foreground)) {
                element.style.color = foreground;
            }

            if (background && /^#[0-9a-f]{6}$/i.test(background)) {
                element.style.backgroundColor = background;
            }
        }

        for (const spoiler of root.querySelectorAll<HTMLElement>("[data-mx-spoiler]")) {
            const reason = spoiler.dataset.mxSpoiler;

            spoiler.tabIndex = 0;
            spoiler.setAttribute("role", "button");
            spoiler.setAttribute("aria-expanded", "false");
            spoiler.setAttribute(
                "aria-label",
                reason ? `Spoiler: ${reason}. Activate to reveal.` : "Spoiler. Activate to reveal.",
            );

            const toggle = () => {
                const revealed = spoiler.toggleAttribute("data-revealed");

                spoiler.setAttribute("aria-expanded", String(revealed));
                spoiler.setAttribute(
                    "aria-label",
                    revealed
                        ? `Revealed spoiler${reason ? ` (${reason})` : ""}: ${spoiler.textContent ?? ""}`
                        : reason
                          ? `Spoiler: ${reason}. Activate to reveal.`
                          : "Spoiler. Activate to reveal.",
                );
            };

            const click = (event: MouseEvent) => {
                event.preventDefault();
                toggle();
            };

            const keydown = (event: KeyboardEvent) => {
                if (event.key !== "Enter" && event.key !== " ") {
                    return;
                }

                event.preventDefault();
                toggle();
            };

            spoiler.addEventListener("click", click);
            spoiler.addEventListener("keydown", keydown);
            cleanups.push(() => {
                spoiler.removeEventListener("click", click);
                spoiler.removeEventListener("keydown", keydown);
            });
        }

        return () => cleanups.forEach((cleanup) => cleanup());
    }, [html]);

    return (
        <div
            ref={bodyRef}
            className={classes("formatted-body")}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}

function YouTubePreviewCard({ preview }: { preview: YouTubePreview }) {
    const [failed, setFailed] = useState(() => youtubeThumbnailFailureStore.has(preview.id));

    const markFailed = () => {
        youtubeThumbnailFailureStore.markFailed(preview.id);
        setFailed(true);
    };

    const contents = (
        <>
            <span className={classes("youtube-preview__media")} aria-hidden="true">
                {failed ? null : (
                    // YouTube must receive the browser-direct public thumbnail URL.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={preview.src}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={markFailed}
                    />
                )}
            </span>
            <span className={classes("youtube-preview__metadata")}>
                {failed ? "YouTube preview unavailable" : "Watch on YouTube"}
            </span>
        </>
    );

    return failed ? (
        <div className={classes("youtube-preview")} aria-label="YouTube preview unavailable">
            {contents}
        </div>
    ) : (
        <a
            className={classes("youtube-preview")}
            href={preview.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Watch video on YouTube"
        >
            {contents}
        </a>
    );
}

function YouTubePreviewCards({ previews }: { previews: YouTubePreview[] }) {
    if (!previews.length) {
        return null;
    }

    return (
        <div className={classes("youtube-preview-list")} aria-label="YouTube previews">
            {previews.map((preview) => (
                <YouTubePreviewCard key={preview.id} preview={preview} />
            ))}
        </div>
    );
}

function replyExcerpt(item: TimelineItem): string {
    const firstLine = item.body.split("\n", 1)[0] ?? item.body;

    return firstLine.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? firstLine;
}

function MessageRow({
    item,
    next,
    replyItem,
    entering,
    service,
    onReply,
    onEdit,
    onOpenMedia,
}: {
    item: TimelineItem;
    next?: TimelineItem;
    replyItem?: TimelineItem;
    entering: boolean;
    service: MatrixService;
    onReply: (item: TimelineItem) => void;
    onEdit: (item: TimelineItem) => void;
    onOpenMedia: (item: TimelineItem, opener: HTMLElement) => void;
}) {
    const [reactionOpen, setReactionOpen] = useState(false);
    /*
     * Which reaction is mid-pop. Set on the click rather than on the round
     * trip, because the pop acknowledges the tap; whether the homeserver
     * accepts it is what the count itself reports a moment later.
     */
    const [poppedReaction, setPoppedReaction] = useState<string | null>(null);
    const popTimer = useRef<number | null>(null);
    const rowRef = useRef<HTMLElement>(null);

    useEffect(
        () => () => {
            if (popTimer.current !== null) {
                window.clearTimeout(popTimer.current);
            }
        },
        [],
    );
    const nextDay =
        next && new Date(next.timestamp).toDateString() !== new Date(item.timestamp).toDateString();
    const actionable = timelineItemHasActions(item);
    const editable = actionable && item.own && item.type === "message" && !item.media;
    const youtubePreviews = useMemo(() => timelineYouTubePreviews(item), [item]);

    if (item.type === "system") {
        return (
            <>
                <div className={classes("system-event")}>
                    <span>{item.body}</span>
                    <time>{formatTime(item.timestamp)}</time>
                </div>
                {nextDay ? <DayDivider timestamp={next.timestamp} /> : null}
            </>
        );
    }

    return (
        <>
            <article
                ref={rowRef}
                className={classes(
                    `message-row${item.own ? " message-row--own" : ""}${item.type === "notice" ? " message-row--notice" : ""}${next ? "" : " message-row--last"}`,
                )}
                style={getAuthorAccentStyle(item, replyItem)}
                data-ui="message-row"
                data-enter={entering ? "in" : undefined}
                data-send-state={item.sendingStatus ?? undefined}
                data-event-id={item.id}
                aria-label={`Message from ${item.senderName}`}
            >
                <time
                    className={classes("message-row__time")}
                    dateTime={new Date(item.timestamp).toISOString()}
                >
                    {formatTime(item.timestamp)}
                </time>
                <div className={classes("message-row__main")} data-ui="message-content">
                    <span className={classes("message-row__marker")} aria-hidden="true" />
                    <header>
                        <strong>{item.own ? "You" : item.senderName}</strong>
                        {item.edited ? (
                            <span className={classes("edited-label")}>edited</span>
                        ) : null}
                        {item.encrypted ? (
                            <span className={classes("encrypted-label")} title="Encrypted message">
                                E2E
                            </span>
                        ) : null}
                    </header>
                    {item.replyTo ? (
                        <div className={classes("reply-context")}>
                            <CornerUpLeft aria-hidden="true" />
                            {replyItem
                                ? `${replyItem.own ? "You" : replyItem.senderName} — ${replyExcerpt(replyItem)}`
                                : item.replySummary
                                  ? `${item.replySummary.senderName} — ${item.replySummary.body}`
                                  : "Reply to an earlier transmission"}
                        </div>
                    ) : null}
                    {item.redacted ? (
                        <p className={classes("redacted-body")}>Message removed</p>
                    ) : item.decryptionState === "decrypting" ? (
                        <div className={classes("decryption-state")} role="status">
                            <LoaderCircle className={classes("spin")} aria-hidden="true" />
                            <span>Decrypting transmission…</span>
                        </div>
                    ) : item.decryptionState === "failed" ? (
                        <div
                            className={classes("decryption-state decryption-state--failed")}
                            role="status"
                        >
                            <ShieldAlert aria-hidden="true" />
                            <span>
                                This transmission could not be decrypted on this device. Sub-Etha
                                will retry if the keys arrive.
                            </span>
                        </div>
                    ) : item.formattedBody ? (
                        <FormattedMessageBody html={item.formattedBody} />
                    ) : item.type === "file" ? null : (
                        <PlainMessageBody body={item.body} />
                    )}
                    <YouTubePreviewCards previews={youtubePreviews} />
                    {item.media ? (
                        <MediaAttachment item={item} service={service} onOpen={onOpenMedia} />
                    ) : null}
                    {item.reactions.length ? (
                        <div className={classes("reaction-list")} aria-label="Reactions">
                            {item.reactions.map((reaction) => (
                                <button
                                    key={reaction.key}
                                    type="button"
                                    className={classes(reaction.mine ? "is-mine" : "")}
                                    data-pop={reaction.key === poppedReaction ? "true" : undefined}
                                    aria-pressed={reaction.mine}
                                    onClick={() => {
                                        setPoppedReaction(reaction.key);

                                        if (popTimer.current !== null) {
                                            window.clearTimeout(popTimer.current);
                                        }

                                        popTimer.current = window.setTimeout(() => {
                                            popTimer.current = null;
                                            setPoppedReaction(null);
                                        }, REACTION_POP_MS);

                                        void service.toggleReaction(item.id, reaction.key);
                                    }}
                                >
                                    <span>{reaction.key}</span>
                                    <span>{reaction.count}</span>
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {item.sendingStatus ? (
                        <div className={classes(`send-status send-status--${item.sendingStatus}`)}>
                            <span>
                                {item.sendingStatus === "not_sent" ? "Could not send" : "Sending…"}
                            </span>
                            {item.sendingStatus === "not_sent" ? (
                                <button type="button" onClick={() => void service.retry(item)}>
                                    <RefreshCw aria-hidden="true" />
                                    Retry
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                    {item.readBy.length ? (
                        <div className={classes("read-receipt")}>
                            <CheckCheck aria-hidden="true" />
                            Read by {item.readBy.join(", ")}
                        </div>
                    ) : null}
                </div>
                {actionable ? (
                    <div
                        className={classes("message-actions")}
                        data-ui="message-actions"
                        aria-label={`Actions for message from ${item.senderName}`}
                    >
                        <button
                            type="button"
                            title="Reply"
                            aria-label="Reply"
                            onClick={() => {
                                setReactionOpen(false);
                                onReply(item);
                            }}
                        >
                            <CornerUpLeft />
                        </button>
                        <button
                            type="button"
                            title="Add reaction"
                            aria-label="Add reaction"
                            aria-expanded={reactionOpen}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => {
                                setReactionOpen((open) => !open);
                            }}
                        >
                            <SmilePlus />
                        </button>
                        {editable ? (
                            <button
                                type="button"
                                title="Edit"
                                aria-label="Edit"
                                onClick={() => onEdit(item)}
                            >
                                <Pencil />
                            </button>
                        ) : null}
                        {item.own ? (
                            <button
                                type="button"
                                title="Remove"
                                aria-label="Remove"
                                onClick={() => void service.redact(item.id)}
                            >
                                <Trash2 />
                            </button>
                        ) : null}
                        {reactionOpen ? (
                            <ReactionPicker
                                item={item}
                                service={service}
                                onClose={() => setReactionOpen(false)}
                            />
                        ) : null}
                    </div>
                ) : null}
            </article>
            {nextDay ? <DayDivider timestamp={next.timestamp} /> : null}
        </>
    );
}

export function Timeline({
    items,
    firstItemIndex,
    service,
    loadingHistory,
    hasMoreHistory,
    initializing,
    unreadCount,
    onReply,
    onEdit,
}: {
    items: TimelineItem[];
    firstItemIndex: number;
    service: MatrixService;
    loadingHistory: boolean;
    hasMoreHistory: boolean;
    initializing: boolean;
    unreadCount: number;
    onReply: (item: TimelineItem) => void;
    onEdit: (item: TimelineItem) => void;
}) {
    const [lightboxId, setLightboxId] = useState<string | null>(null);
    const [scrollMode, setScrollMode] = useState<TimelineScrollMode>("initializing");
    const [unreadBoundaryId, setUnreadBoundaryId] = useState<string | null>(() =>
        initialUnreadBoundaryId(items, unreadCount),
    );
    const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(NO_ENTERING_ITEMS);
    const knownItemIds = useRef<Set<string>>(new Set());
    const enterTrackingReady = useRef(false);
    const enterTimers = useRef<Map<string, number>>(new Map());
    const lightboxOpener = useRef<HTMLElement | null>(null);
    const scroller = useRef<HTMLElement | null>(null);
    const removeScrollerListeners = useRef<(() => void) | null>(null);
    const scrollModeRef = useRef<TimelineScrollMode>("initializing");
    const previousItems = useRef<TimelineIdentity[]>([]);
    const previousFirstItemIndex = useRef(firstItemIndex);
    const historyAnchor = useRef<TimelineHistoryAnchor | null>(null);
    const historyAnchorFrame = useRef<number | null>(null);
    const historyRestoreDeferred = useRef(false);
    const detachedViewportAnchor = useRef<TimelineHistoryAnchor | null>(null);
    const detachedRestoreFrame = useRef<number | null>(null);
    const historyRequestInFlight = useRef(false);
    const historyRequestGeneration = useRef(0);
    const touchY = useRef<number | null>(null);
    const pointerGesture = useRef<{ id: number; y: number } | null>(null);
    const scrollbarPointerActive = useRef(false);
    const bottomFrame = useRef<number | null>(null);
    const bottomPositionPending = useRef(false);
    const scheduleBottomPositionRef = useRef<() => void>(() => undefined);
    const programmaticResetFrame = useRef<number | null>(null);
    const newestMessageFrame = useRef<number | null>(null);
    const programmaticScroll = useRef(false);
    const userScrollActive = useRef(false);
    const userScrollEndTimer = useRef<number | null>(null);
    const userScrollEndFrame = useRef<number | null>(null);
    const finishUserScrollRef = useRef<() => void>(() => undefined);
    const userScrollDirection = useRef<UserScrollDirection>(0);
    const olderIntentLatched = useRef(false);
    // Virtuoso can report `startReached` while it is still resolving the
    // initial align-to-bottom layout. Keep that notification inert until a
    // real upward gesture has handed history pagination to the user.
    const historyPaginationIntent = useRef(false);
    const unreadBoundaryInitialized = useRef(items.length > 0 || !initializing);
    const transitionScrollMode = useCallback((event: TimelineScrollEvent) => {
        const nextMode = transitionTimelineScrollMode(scrollModeRef.current, event);

        if (nextMode === "attached" || nextMode === "initializing") {
            detachedViewportAnchor.current = null;
        }

        scrollModeRef.current = nextMode;
        setScrollMode((current) => (current === nextMode ? current : nextMode));
    }, []);
    const captureDetachedAnchor = useCallback(() => {
        const element = scroller.current;
        const bounds = element?.getBoundingClientRect();

        if (!element || !bounds) {
            return;
        }

        const visibleEvent = [...element.querySelectorAll<HTMLElement>("[data-event-id]")]
            .filter((candidate) => {
                const candidateBounds = candidate.getBoundingClientRect();

                return candidateBounds.bottom > bounds.top && candidateBounds.top < bounds.bottom;
            })
            .sort(
                (left, right) =>
                    left.getBoundingClientRect().top - right.getBoundingClientRect().top,
            )[0];

        if (!visibleEvent?.dataset.eventId) {
            return;
        }

        detachedViewportAnchor.current = {
            id: visibleEvent.dataset.eventId,
            index: Number.parseInt(
                visibleEvent.closest<HTMLElement>("[data-index]")?.dataset.index ?? "0",
                10,
            ),
            target: "event",
            top: visibleEvent.getBoundingClientRect().top,
        };
    }, []);
    const refreshHistoryAnchorPosition = useCallback(() => {
        const element = scroller.current;
        const anchor = historyAnchor.current;
        const scrollerBounds = element?.getBoundingClientRect();

        if (!element || !anchor || !scrollerBounds) {
            return;
        }

        const anchorElement =
            anchor.target === "event"
                ? [...element.querySelectorAll<HTMLElement>("[data-event-id]")].find(
                      (candidate) => candidate.dataset.eventId === anchor.id,
                  )
                : element.querySelector<HTMLElement>(`[data-index="${anchor.index}"]`);

        const anchorBounds = anchorElement?.getBoundingClientRect();

        if (
            anchorElement &&
            anchorBounds &&
            anchorBounds.bottom > scrollerBounds.top &&
            anchorBounds.top < scrollerBounds.bottom
        ) {
            anchor.top = anchorBounds.top;
            anchor.index = Number.parseInt(
                anchorElement.closest<HTMLElement>("[data-index]")?.dataset.index ??
                    `${anchor.index}`,
                10,
            );

            return;
        }

        const visibleEvent = [...element.querySelectorAll<HTMLElement>("[data-event-id]")]
            .filter((candidate) => {
                const bounds = candidate.getBoundingClientRect();

                return bounds.bottom > scrollerBounds.top && bounds.top < scrollerBounds.bottom;
            })
            .sort(
                (left, right) =>
                    left.getBoundingClientRect().top - right.getBoundingClientRect().top,
            )[0];

        if (visibleEvent?.dataset.eventId) {
            historyAnchor.current = {
                id: visibleEvent.dataset.eventId,
                index: Number.parseInt(
                    visibleEvent.closest<HTMLElement>("[data-index]")?.dataset.index ??
                        `${anchor.index}`,
                    10,
                ),
                target: "event",
                top: visibleEvent.getBoundingClientRect().top,
            };
        }
    }, []);
    const scheduleDetachedAnchorRestore = useCallback(() => {
        if (detachedRestoreFrame.current !== null) {
            window.cancelAnimationFrame(detachedRestoreFrame.current);
        }

        detachedRestoreFrame.current = window.requestAnimationFrame(() => {
            detachedRestoreFrame.current = window.requestAnimationFrame(() => {
                detachedRestoreFrame.current = null;

                if (scrollModeRef.current !== "detached" || userScrollActive.current) {
                    return;
                }

                const element = scroller.current;
                const anchor = detachedViewportAnchor.current;
                const anchorElement = anchor
                    ? [...(element?.querySelectorAll<HTMLElement>("[data-event-id]") ?? [])].find(
                          (candidate) => candidate.dataset.eventId === anchor.id,
                      )
                    : null;

                if (!element || !anchor || !anchorElement) {
                    return;
                }

                const correction = anchorElement.getBoundingClientRect().top - anchor.top;

                if (Math.abs(correction) <= 0.5) {
                    return;
                }

                programmaticScroll.current = true;
                element.scrollTop += correction;
                window.requestAnimationFrame(() => {
                    programmaticScroll.current = false;
                });
            });
        });
    }, []);
    const cancelHistoryRestoration = useCallback(() => {
        if (historyAnchorFrame.current !== null) {
            window.cancelAnimationFrame(historyAnchorFrame.current);
            historyAnchorFrame.current = null;
        }

        historyAnchor.current = null;
        historyRestoreDeferred.current = false;
        programmaticScroll.current = false;

        if (scrollModeRef.current === "restoring-history") {
            transitionScrollMode({ type: "user-detach" });
        }
    }, [transitionScrollMode]);
    const imageItems = useMemo(
        () => items.filter((item) => item.type === "image" && item.media && !item.redacted),
        [items],
    );
    const itemsById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
    const estimateViewportWidth = typeof window === "undefined" ? 1_920 : window.innerWidth;
    const itemHeightEstimates = useMemo(
        () => items.map((item) => estimateTimelineItemHeight(item, estimateViewportWidth)),
        [estimateViewportWidth, items],
    );
    const estimateLayoutSignature = useMemo(
        () =>
            items
                .map((item) => {
                    const youtubePreviews = timelineYouTubePreviews(item);
                    const youtubeEligible = isTimelineYouTubePreviewEligible(item);

                    return `${item.id}:${item.type}:${item.media ? `${item.media.width ?? "?"}x${item.media.height ?? "?"}` : "none"}:youtube=${youtubeEligible ? "eligible" : "ineligible"}:${youtubePreviews.length}:${youtubePreviews.map((preview) => preview.id).join(",")}`;
                })
                .join("|"),
        [items],
    );
    const previousEstimateLayoutSignature = useRef(estimateLayoutSignature);
    const [estimateLayoutRevision, setEstimateLayoutRevision] = useState(0);

    useLayoutEffect(() => {
        if (previousEstimateLayoutSignature.current === estimateLayoutSignature) {
            return;
        }

        previousEstimateLayoutSignature.current = estimateLayoutSignature;

        if (scrollModeRef.current === "attached" || scrollModeRef.current === "initializing") {
            setEstimateLayoutRevision((revision) => revision + 1);
        }
    }, [estimateLayoutSignature]);
    const loadEarlierHistory = useCallback(
        (fromUserGesture = false) => {
            if (
                scrollModeRef.current === "initializing" ||
                !hasMoreHistory ||
                loadingHistory ||
                historyRequestInFlight.current
            ) {
                return;
            }

            if (!fromUserGesture && !historyPaginationIntent.current) {
                return;
            }

            historyPaginationIntent.current = false;

            cancelHistoryRestoration();
            detachedViewportAnchor.current = null;
            const element = scroller.current;
            const scrollerBounds = element?.getBoundingClientRect();
            const visibleEvent =
                element && scrollerBounds
                    ? [...element.querySelectorAll<HTMLElement>("[data-event-id]")]
                          .filter((candidate) => {
                              const bounds = candidate.getBoundingClientRect();

                              return (
                                  bounds.bottom > scrollerBounds.top &&
                                  bounds.top < scrollerBounds.bottom
                              );
                          })
                          .sort(
                              (left, right) =>
                                  left.getBoundingClientRect().top -
                                  right.getBoundingClientRect().top,
                          )[0]
                    : null;
            const firstRenderedItem = element?.querySelector<HTMLElement>("[data-index]") ?? null;

            historyAnchor.current = visibleEvent?.dataset.eventId
                ? {
                      id: visibleEvent.dataset.eventId,
                      index: Number.parseInt(
                          visibleEvent.closest<HTMLElement>("[data-index]")?.dataset.index ??
                              `${firstItemIndex}`,
                          10,
                      ),
                      target: "event",
                      top: visibleEvent.getBoundingClientRect().top,
                  }
                : firstRenderedItem
                  ? {
                        id: items[0]?.id ?? "",
                        index: Number.parseInt(
                            firstRenderedItem.dataset.index ?? `${firstItemIndex}`,
                            10,
                        ),
                        target: "item",
                        top: firstRenderedItem.getBoundingClientRect().top,
                    }
                  : null;
            historyRequestInFlight.current = true;
            const requestGeneration = ++historyRequestGeneration.current;
            const requestedFirstItemIndex = firstItemIndex;

            void service.paginate().finally(() => {
                if (historyRequestGeneration.current !== requestGeneration) {
                    return;
                }

                historyRequestInFlight.current = false;
                const resolvedAt = window.performance.now();
                let graceFramesRemaining = HISTORY_COMMIT_GRACE_FRAMES;

                const reconcileCommittedHistory = () => {
                    if (historyRequestGeneration.current !== requestGeneration) {
                        return;
                    }

                    if (previousFirstItemIndex.current !== requestedFirstItemIndex) {
                        return;
                    }

                    if (
                        graceFramesRemaining > 0 &&
                        window.performance.now() - resolvedAt < HISTORY_COMMIT_GRACE_MAX_MS
                    ) {
                        graceFramesRemaining -= 1;
                        window.requestAnimationFrame(reconcileCommittedHistory);

                        return;
                    }

                    historyAnchor.current = null;
                    historyRestoreDeferred.current = false;

                    if (scrollModeRef.current === "restoring-history") {
                        transitionScrollMode({ type: "history-complete" });
                    }

                    if (scrollModeRef.current !== "attached" && !userScrollActive.current) {
                        captureDetachedAnchor();
                    }
                };

                window.requestAnimationFrame(reconcileCommittedHistory);
            });
        },
        [
            cancelHistoryRestoration,
            captureDetachedAnchor,
            firstItemIndex,
            hasMoreHistory,
            items,
            loadingHistory,
            service,
            transitionScrollMode,
        ],
    );

    const firstTimestamp = items[0]?.timestamp ?? null;
    const virtuosoContext = useMemo(
        () => ({
            loadingHistory,
            hasMoreHistory,
            firstTimestamp,
            requestEarlierHistory: () => loadEarlierHistory(true),
        }),
        [firstTimestamp, hasMoreHistory, loadEarlierHistory, loadingHistory],
    );

    const restoreHistoryAnchor = useCallback(() => {
        if (historyAnchorFrame.current !== null) {
            window.cancelAnimationFrame(historyAnchorFrame.current);
            historyAnchorFrame.current = null;
        }

        if (userScrollActive.current) {
            historyRestoreDeferred.current = true;
            programmaticScroll.current = false;
            transitionScrollMode({ type: "history-complete" });

            return;
        }

        transitionScrollMode({ type: "history-start" });
        historyRestoreDeferred.current = false;
        const startedAt = window.performance.now();
        let stableFrames = 0;

        const restore = () => {
            historyAnchorFrame.current = null;

            if (userScrollActive.current) {
                historyRestoreDeferred.current = true;
                programmaticScroll.current = false;
                transitionScrollMode({ type: "history-complete" });

                return;
            }

            const element = scroller.current;
            const anchor = historyAnchor.current;

            if (!element || !anchor) {
                historyAnchor.current = null;
                historyRestoreDeferred.current = false;
                programmaticScroll.current = false;
                transitionScrollMode({ type: "history-complete" });
                captureDetachedAnchor();

                return;
            }

            const anchorElement =
                anchor.target === "event"
                    ? [...element.querySelectorAll<HTMLElement>("[data-event-id]")].find(
                          (candidate) => candidate.dataset.eventId === anchor.id,
                      )
                    : element.querySelector<HTMLElement>(`[data-index="${anchor.index}"]`);

            if (anchorElement) {
                const delta = anchorElement.getBoundingClientRect().top - anchor.top;

                if (Math.abs(delta) > 0.5) {
                    programmaticScroll.current = true;
                    element.scrollTop += delta;
                    stableFrames = 0;
                } else {
                    stableFrames += 1;
                }
            } else {
                stableFrames = 0;
            }

            const elapsed = window.performance.now() - startedAt;
            const stillSettling =
                elapsed < HISTORY_ANCHOR_MIN_SETTLE_MS ||
                stableFrames < HISTORY_ANCHOR_STABLE_FRAMES;

            if (elapsed < HISTORY_ANCHOR_MAX_SETTLE_MS && stillSettling) {
                historyAnchorFrame.current = window.requestAnimationFrame(restore);

                return;
            }

            historyAnchor.current = null;
            historyRestoreDeferred.current = false;
            programmaticScroll.current = false;
            transitionScrollMode({ type: "history-complete" });
            captureDetachedAnchor();
        };

        restore();
    }, [captureDetachedAnchor, transitionScrollMode]);

    const pauseHistoryRestoration = useCallback(() => {
        if (
            !historyAnchor.current ||
            (historyAnchorFrame.current === null &&
                !historyRestoreDeferred.current &&
                scrollModeRef.current !== "restoring-history")
        ) {
            return;
        }

        if (historyAnchorFrame.current !== null) {
            window.cancelAnimationFrame(historyAnchorFrame.current);
            historyAnchorFrame.current = null;
        }

        historyRestoreDeferred.current = true;
        programmaticScroll.current = false;

        if (scrollModeRef.current === "restoring-history") {
            transitionScrollMode({ type: "history-complete" });
        }
    }, [transitionScrollMode]);

    const closeLightbox = () => {
        setLightboxId(null);
        window.requestAnimationFrame(() => lightboxOpener.current?.focus());
    };

    const finishUserScroll = useCallback(() => {
        if (userScrollEndTimer.current !== null) {
            window.clearTimeout(userScrollEndTimer.current);
            userScrollEndTimer.current = null;
        }

        if (!userScrollActive.current) {
            return;
        }

        if (
            touchY.current !== null ||
            pointerGesture.current !== null ||
            scrollbarPointerActive.current
        ) {
            userScrollEndTimer.current = window.setTimeout(() => {
                userScrollEndTimer.current = null;
                finishUserScrollRef.current();
            }, USER_SCROLL_END_DELAY_MS);

            return;
        }

        if (userScrollEndFrame.current !== null) {
            window.cancelAnimationFrame(userScrollEndFrame.current);
        }

        userScrollEndFrame.current = window.requestAnimationFrame(() => {
            userScrollEndFrame.current = null;

            if (!userScrollActive.current) {
                return;
            }

            const element = scroller.current;
            const atBottom = element
                ? element.scrollHeight - element.clientHeight - element.scrollTop <=
                  TIMELINE_BOTTOM_TOLERANCE_PX
                : false;
            const direction = userScrollDirection.current;
            const hadOlderIntent = olderIntentLatched.current;
            const restoreDeferredHistory =
                historyRestoreDeferred.current && historyAnchor.current !== null;

            userScrollActive.current = false;
            userScrollDirection.current = 0;
            olderIntentLatched.current = false;

            if (direction > 0) {
                historyPaginationIntent.current = false;
            }

            if (restoreDeferredHistory) {
                historyRestoreDeferred.current = false;
                restoreHistoryAnchor();

                return;
            }

            if (
                atBottom &&
                scrollModeRef.current === "detached" &&
                direction === 1 &&
                !hadOlderIntent
            ) {
                transitionScrollMode({ type: "bottom-state", atBottom: true });
            } else if (scrollModeRef.current === "detached") {
                captureDetachedAnchor();
            }

            if (bottomPositionPending.current && scrollModeRef.current === "attached") {
                scheduleBottomPositionRef.current();
            }
        });
    }, [captureDetachedAnchor, restoreHistoryAnchor, transitionScrollMode]);

    useLayoutEffect(() => {
        finishUserScrollRef.current = finishUserScroll;
    }, [finishUserScroll]);

    const armUserScrollEnd = useCallback(() => {
        if (!userScrollActive.current) {
            return;
        }

        if (userScrollEndFrame.current !== null) {
            window.cancelAnimationFrame(userScrollEndFrame.current);
            userScrollEndFrame.current = null;
        }

        if (userScrollEndTimer.current !== null) {
            window.clearTimeout(userScrollEndTimer.current);
        }

        userScrollEndTimer.current = window.setTimeout(() => {
            userScrollEndTimer.current = null;
            finishUserScroll();
        }, USER_SCROLL_END_DELAY_MS);
    }, [finishUserScroll]);

    const beginUserScroll = useCallback(
        (direction: UserScrollDirection = 0) => {
            pauseHistoryRestoration();

            userScrollActive.current = true;

            if (direction !== 0) {
                userScrollDirection.current = direction;
            }

            if (direction < 0) {
                olderIntentLatched.current = true;
            }

            armUserScrollEnd();
        },
        [armUserScrollEnd, pauseHistoryRestoration],
    );

    const detachFromBottom = useCallback(() => {
        beginUserScroll(-1);
        historyPaginationIntent.current = true;

        if (bottomFrame.current !== null) {
            window.cancelAnimationFrame(bottomFrame.current);
            bottomFrame.current = null;
        }

        bottomPositionPending.current = false;

        if (programmaticResetFrame.current !== null) {
            window.cancelAnimationFrame(programmaticResetFrame.current);
            programmaticResetFrame.current = null;
        }

        if (detachedRestoreFrame.current !== null) {
            window.cancelAnimationFrame(detachedRestoreFrame.current);
            detachedRestoreFrame.current = null;
        }

        if (newestMessageFrame.current !== null) {
            window.cancelAnimationFrame(newestMessageFrame.current);
            newestMessageFrame.current = null;
        }

        programmaticScroll.current = false;
        detachedViewportAnchor.current = null;

        transitionScrollMode({ type: "user-detach" });
    }, [beginUserScroll, transitionScrollMode]);

    const scheduleBottomPosition = useCallback(() => {
        bottomPositionPending.current = true;

        if (bottomFrame.current !== null) {
            return;
        }

        bottomFrame.current = window.requestAnimationFrame(() => {
            bottomFrame.current = null;

            if (scrollModeRef.current !== "attached") {
                bottomPositionPending.current = false;

                return;
            }

            if (userScrollActive.current) {
                return;
            }

            const element = scroller.current;

            if (!element) {
                bottomPositionPending.current = false;

                return;
            }

            bottomPositionPending.current = false;
            programmaticScroll.current = true;
            element.scrollTo({ top: element.scrollHeight, behavior: "auto" });

            if (programmaticResetFrame.current !== null) {
                window.cancelAnimationFrame(programmaticResetFrame.current);
            }

            programmaticResetFrame.current = window.requestAnimationFrame(() => {
                programmaticScroll.current = false;
                programmaticResetFrame.current = null;
            });
        });
    }, []);

    useLayoutEffect(() => {
        scheduleBottomPositionRef.current = scheduleBottomPosition;
    }, [scheduleBottomPosition]);

    // Virtuoso reports a viewport-sized scroll height until it has measured the
    // rows, so "already at the bottom" is meaningless on the first frames after
    // a room opens. Hold the timeline against the newest message until the end
    // of the list stays put across consecutive frames; only then hand over to
    // the attached-mode handlers. Leaving `initializing` early stranded readers
    // at the top of an unmeasured list, where `startReached` then paginated more
    // history in and pushed the newest message even further out of reach.
    const settleAtNewestMessage = useCallback(() => {
        if (newestMessageFrame.current !== null || scrollModeRef.current !== "initializing") {
            return;
        }

        let startedAt: number | null = null;
        let stableFrames = 0;

        const settle = () => {
            newestMessageFrame.current = null;

            if (scrollModeRef.current !== "initializing") {
                programmaticScroll.current = false;

                return;
            }

            const element = scroller.current;

            if (!element) {
                // The list is not mounted yet; `itemsRendered` restarts the settle.
                programmaticScroll.current = false;

                return;
            }

            startedAt ??= window.performance.now();
            const distanceFromBottom =
                element.scrollHeight - element.clientHeight - element.scrollTop;

            if (userScrollActive.current) {
                stableFrames = 0;
            } else if (distanceFromBottom > TIMELINE_BOTTOM_TOLERANCE_PX) {
                programmaticScroll.current = true;
                element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
                stableFrames = 0;
            } else {
                stableFrames += 1;
            }

            const elapsed = window.performance.now() - startedAt;
            const stillSettling =
                elapsed < NEWEST_MESSAGE_MIN_SETTLE_MS ||
                stableFrames < NEWEST_MESSAGE_STABLE_FRAMES;

            if (elapsed < NEWEST_MESSAGE_MAX_SETTLE_MS && stillSettling) {
                newestMessageFrame.current = window.requestAnimationFrame(settle);

                return;
            }

            programmaticScroll.current = false;
            transitionScrollMode({ type: "initial-positioned" });
        };

        newestMessageFrame.current = window.requestAnimationFrame(settle);
    }, [transitionScrollMode]);

    const preservePositionAfterGeometryChange = useCallback(() => {
        if (userScrollActive.current) {
            return;
        }

        if (scrollModeRef.current === "attached") {
            scheduleBottomPosition();

            return;
        }

        if (scrollModeRef.current === "detached" && detachedViewportAnchor.current) {
            scheduleDetachedAnchorRestore();
        }
    }, [scheduleBottomPosition, scheduleDetachedAnchorRestore]);

    const preserveAttachedBottomAfterTimelineHeightChange = useCallback(() => {
        if (userScrollActive.current) {
            return;
        }

        if (scrollModeRef.current === "attached") {
            scheduleBottomPosition();

            return;
        }

        if (scrollModeRef.current === "initializing") {
            // Virtuoso may recalculate the virtual list after the initial
            // settle loop has observed a provisional height. Re-assert the
            // newest edge for every such geometry change while attachment is
            // still withheld; otherwise the first attached frame can be tens
            // of thousands of pixels above the live edge.
            const element = scroller.current;

            if (element) {
                programmaticScroll.current = true;
                element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
            }

            settleAtNewestMessage();
        }
    }, [scheduleBottomPosition, settleAtNewestMessage]);

    const setScroller = useCallback(
        (value: HTMLElement | Window | null) => {
            removeScrollerListeners.current?.();
            removeScrollerListeners.current = null;
            scroller.current = value instanceof HTMLElement ? value : null;
            const element = scroller.current;

            if (!element) {
                return;
            }

            let lastScrollTop = element.scrollTop;

            const onScroll = () => {
                const scrollDelta = element.scrollTop - lastScrollTop;

                lastScrollTop = element.scrollTop;
                const atBottom =
                    element.scrollHeight - element.clientHeight - element.scrollTop <=
                    TIMELINE_BOTTOM_TOLERANCE_PX;
                const atTop = element.scrollTop <= TIMELINE_BOTTOM_TOLERANCE_PX;

                if (
                    userScrollActive.current &&
                    !programmaticScroll.current &&
                    Math.abs(scrollDelta) > 0.5
                ) {
                    const inputDirection = scrollbarPointerActive.current
                        ? scrollDelta < 0
                            ? -1
                            : 1
                        : userScrollDirection.current;
                    const movedInRequestedDirection =
                        inputDirection !== 0 && Math.sign(scrollDelta) === inputDirection;

                    if (historyAnchor.current && movedInRequestedDirection) {
                        refreshHistoryAnchorPosition();
                    }

                    if (scrollbarPointerActive.current) {
                        if (scrollDelta < 0) {
                            detachFromBottom();
                        } else {
                            beginUserScroll(1);
                        }
                    } else {
                        armUserScrollEnd();
                    }

                    if (
                        atBottom &&
                        scrollModeRef.current === "detached" &&
                        userScrollDirection.current === 1 &&
                        !olderIntentLatched.current
                    ) {
                        transitionScrollMode({ type: "bottom-state", atBottom: true });
                    }
                }

                // `startReached` is debounced by Virtuoso and may have
                // already emitted (and been intentionally ignored) during
                // the initial layout. A real upward gesture that reaches the
                // top must still paginate even when the stream has no new
                // value to publish.
                if (
                    atTop &&
                    scrollModeRef.current === "detached" &&
                    historyPaginationIntent.current
                ) {
                    loadEarlierHistory();
                }
            };

            const onWheel = (event: WheelEvent) => {
                if (event.deltaY < 0) {
                    detachFromBottom();
                } else if (event.deltaY > 0) {
                    beginUserScroll(1);
                }
            };

            const onTouchStart = (event: TouchEvent) => {
                touchY.current = event.touches[0]?.clientY ?? null;
            };

            const onTouchMove = (event: TouchEvent) => {
                const nextY = event.touches[0]?.clientY;

                if (nextY === undefined) {
                    return;
                }

                if (touchY.current !== null && Math.abs(nextY - touchY.current) > 1) {
                    if (nextY > touchY.current) {
                        detachFromBottom();
                    } else {
                        beginUserScroll(1);
                    }
                }

                touchY.current = nextY;
            };

            const clearTouch = () => {
                touchY.current = null;
            };

            const onPointerDown = (event: PointerEvent) => {
                if (event.pointerType === "mouse") {
                    const bounds = element.getBoundingClientRect();

                    scrollbarPointerActive.current = event.clientX >= bounds.right - 24;

                    if (scrollbarPointerActive.current) {
                        beginUserScroll();
                    }

                    return;
                }

                pointerGesture.current = { id: event.pointerId, y: event.clientY };
            };

            const onPointerMove = (event: PointerEvent) => {
                if (event.pointerType === "mouse") {
                    if (scrollbarPointerActive.current) {
                        beginUserScroll();
                    }

                    return;
                }

                const current = pointerGesture.current;

                if (!current || current.id !== event.pointerId) {
                    return;
                }

                if (event.clientY > current.y + 3) {
                    detachFromBottom();
                } else if (Math.abs(event.clientY - current.y) > 1) {
                    beginUserScroll(event.clientY > current.y ? -1 : 1);
                }

                pointerGesture.current = { id: event.pointerId, y: event.clientY };
            };

            const onScrollEnd = () => armUserScrollEnd();

            const clearPointer = (event: PointerEvent) => {
                if (event.pointerType === "mouse") {
                    scrollbarPointerActive.current = false;
                }

                if (pointerGesture.current?.id === event.pointerId) {
                    pointerGesture.current = null;
                }
            };

            const resizeObserver = new ResizeObserver(preservePositionAfterGeometryChange);

            element.addEventListener("scroll", onScroll, { passive: true });
            element.addEventListener("wheel", onWheel, { passive: true });
            element.addEventListener("touchstart", onTouchStart, { passive: true });
            element.addEventListener("touchmove", onTouchMove, { passive: true });
            element.addEventListener("touchend", clearTouch, { passive: true });
            element.addEventListener("touchcancel", clearTouch, { passive: true });
            element.addEventListener("pointerdown", onPointerDown, { passive: true });
            element.addEventListener("pointermove", onPointerMove, { passive: true });
            element.addEventListener("pointerup", clearPointer, { passive: true });
            element.addEventListener("pointercancel", clearPointer, { passive: true });
            element.addEventListener("scrollend", onScrollEnd, { passive: true });
            window.addEventListener("pointerup", clearPointer, { passive: true });
            window.addEventListener("pointercancel", clearPointer, { passive: true });
            resizeObserver.observe(element);

            removeScrollerListeners.current = () => {
                resizeObserver.disconnect();
                element.removeEventListener("scroll", onScroll);
                element.removeEventListener("wheel", onWheel);
                element.removeEventListener("touchstart", onTouchStart);
                element.removeEventListener("touchmove", onTouchMove);
                element.removeEventListener("touchend", clearTouch);
                element.removeEventListener("touchcancel", clearTouch);
                element.removeEventListener("pointerdown", onPointerDown);
                element.removeEventListener("pointermove", onPointerMove);
                element.removeEventListener("pointerup", clearPointer);
                element.removeEventListener("pointercancel", clearPointer);
                element.removeEventListener("scrollend", onScrollEnd);
                window.removeEventListener("pointerup", clearPointer);
                window.removeEventListener("pointercancel", clearPointer);
            };
        },
        [
            armUserScrollEnd,
            beginUserScroll,
            detachFromBottom,
            loadEarlierHistory,
            preservePositionAfterGeometryChange,
            refreshHistoryAnchorPosition,
            transitionScrollMode,
        ],
    );

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || isEditableKeyboardTarget(event.target)) {
                return;
            }

            const upwardKey =
                event.key === "ArrowUp" ||
                event.key === "PageUp" ||
                event.key === "Home" ||
                (event.key === " " && event.shiftKey);
            const scrollKey =
                upwardKey ||
                event.key === "ArrowDown" ||
                event.key === "PageDown" ||
                event.key === "End" ||
                event.key === " ";

            if (upwardKey && scroller.current) {
                detachFromBottom();
            } else if (scrollKey && scroller.current) {
                beginUserScroll(1);
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [beginUserScroll, detachFromBottom]);

    useLayoutEffect(() => {
        if (unreadBoundaryInitialized.current || initializing || items.length === 0) {
            return;
        }

        unreadBoundaryInitialized.current = true;
        setUnreadBoundaryId(initialUnreadBoundaryId(items, unreadCount));
    }, [initializing, items, unreadCount]);

    /*
     * Only genuinely new events animate. Virtuoso mounts and unmounts rows as
     * the reader scrolls, so a plain mount animation would replay all the way
     * up a conversation; an event is instead marked as entering once, on the
     * commit that first carries it, and the marker is dropped again when the
     * animation is over. Backfilled history is included deliberately — it is
     * new to the reader too — and the animation moves only opacity and
     * transform, so it cannot disturb the geometry the history anchor restores.
     */
    useEffect(() => {
        const known = knownItemIds.current;
        const currentIds = new Set(items.map((item) => item.id));

        if (initializing) {
            return;
        }

        // The first commit after initialization is the room as it was found, not
        // an arrival. This also arms an empty room so its first later message
        // can animate normally.
        if (!enterTrackingReady.current) {
            for (const item of items) {
                known.add(timelineEntranceIdentity(item));
            }

            enterTrackingReady.current = true;

            return;
        }

        const arrivedItems = items.filter((item) => !known.has(timelineEntranceIdentity(item)));
        const arrived = arrivedItems.map((item) => item.id);

        const pruneEnteringIds = (previous: ReadonlySet<string>): ReadonlySet<string> => {
            const next = new Set([...previous].filter((id) => currentIds.has(id)));

            return next.size === previous.size && [...previous].every((id) => currentIds.has(id))
                ? previous
                : next.size
                  ? next
                  : NO_ENTERING_ITEMS;
        };

        if (arrived.length === 0) {
            setEnteringIds(pruneEnteringIds);

            return;
        }

        for (const item of arrivedItems) {
            known.add(timelineEntranceIdentity(item));
        }

        if (known.size > KNOWN_ITEM_ID_LIMIT) {
            knownItemIds.current = new Set(items.map(timelineEntranceIdentity));
        }

        /*
         * Only the live edge animates. Backfilled history is new to the reader
         * too, but `getBoundingClientRect` reports a transformed element where
         * the transform has put it, and the history anchor restores the reader
         * by comparing exactly those tops — so a row sliding into place while
         * the anchor measures it moves the reader instead of the row. History
         * is meant to appear without motion here anyway; that is the promise
         * the anchor exists to keep.
         */
        const suffixStart = items.length - arrived.length;
        const appended = arrived.every((id, offset) => items[suffixStart + offset]?.id === id);

        if (!appended) {
            setEnteringIds(pruneEnteringIds);

            return;
        }

        setEnteringIds((previous) => {
            const next = new Set(pruneEnteringIds(previous));

            for (const id of arrived) {
                next.add(id);
            }

            return next;
        });

        for (const id of arrived) {
            const previousTimer = enterTimers.current.get(id);

            if (previousTimer !== undefined) {
                window.clearTimeout(previousTimer);
            }

            const timer = window.setTimeout(() => {
                enterTimers.current.delete(id);
                setEnteringIds((previous) => {
                    if (!previous.has(id)) {
                        return previous;
                    }

                    const next = new Set(previous);

                    next.delete(id);

                    return next.size ? next : NO_ENTERING_ITEMS;
                });
            }, ENTER_ANIMATION_MS);

            enterTimers.current.set(id, timer);
        }
    }, [initializing, items]);

    useEffect(
        () => () => {
            for (const timer of enterTimers.current.values()) {
                window.clearTimeout(timer);
            }

            enterTimers.current.clear();
        },
        [],
    );

    useLayoutEffect(() => {
        const nextItems = items.map((item) => ({
            id: item.id,
            local: item.sendingStatus !== null,
        }));
        const previousStartIndex = previousFirstItemIndex.current;
        const change = classifyTimelineChange(
            previousItems.current,
            nextItems,
            previousStartIndex,
            firstItemIndex,
        );

        previousItems.current = nextItems;
        previousFirstItemIndex.current = firstItemIndex;

        if (firstItemIndex < previousStartIndex) {
            const latestReadingAnchor = detachedViewportAnchor.current;

            detachedViewportAnchor.current = null;

            // A user can continue moving after startReached begins the request.
            // Prefer the last anchor captured when that gesture settled over
            // the earlier request-time position.
            if (historyAnchor.current && latestReadingAnchor) {
                historyAnchor.current = { ...latestReadingAnchor };
            }

            if (scrollModeRef.current === "attached") {
                cancelHistoryRestoration();
            } else if (historyAnchor.current) {
                restoreHistoryAnchor();
            } else if (scrollModeRef.current === "restoring-history") {
                transitionScrollMode({ type: "history-complete" });
            }
        } else if (change.kind === "replace") {
            cancelHistoryRestoration();
            historyRequestGeneration.current += 1;
            historyRequestInFlight.current = false;
            bottomPositionPending.current = false;
            programmaticScroll.current = false;
        }

        if (change.kind === "initial") {
            settleAtNewestMessage();

            return;
        }

        if (!shouldFollowTimelineChange(change, scrollMode)) {
            if (scrollMode === "detached") {
                scheduleDetachedAnchorRestore();
            }

            return;
        }

        const wasAttachedRemoteAppend = change.kind === "append" && scrollMode === "attached";

        if (change.appendedLocalItem) {
            cancelHistoryRestoration();
            historyPaginationIntent.current = false;
            transitionScrollMode({ type: "local-append" });
        } else if (wasAttachedRemoteAppend) {
            transitionScrollMode({ type: "bottom-state", atBottom: true });
        }

        scheduleBottomPosition();
    }, [
        cancelHistoryRestoration,
        firstItemIndex,
        items,
        restoreHistoryAnchor,
        scheduleBottomPosition,
        scheduleDetachedAnchorRestore,
        scrollMode,
        settleAtNewestMessage,
        transitionScrollMode,
    ]);

    useEffect(
        () => () => {
            removeScrollerListeners.current?.();

            if (bottomFrame.current !== null) {
                window.cancelAnimationFrame(bottomFrame.current);
            }

            if (programmaticResetFrame.current !== null) {
                window.cancelAnimationFrame(programmaticResetFrame.current);
            }

            if (historyAnchorFrame.current !== null) {
                window.cancelAnimationFrame(historyAnchorFrame.current);
            }

            if (detachedRestoreFrame.current !== null) {
                window.cancelAnimationFrame(detachedRestoreFrame.current);
            }

            if (newestMessageFrame.current !== null) {
                window.cancelAnimationFrame(newestMessageFrame.current);
            }

            if (userScrollEndTimer.current !== null) {
                window.clearTimeout(userScrollEndTimer.current);
            }

            if (userScrollEndFrame.current !== null) {
                window.cancelAnimationFrame(userScrollEndFrame.current);
            }

            historyAnchor.current = null;
            historyRestoreDeferred.current = false;
            detachedViewportAnchor.current = null;
            historyRequestGeneration.current += 1;
            historyRequestInFlight.current = false;
            bottomPositionPending.current = false;
            programmaticScroll.current = false;
            userScrollActive.current = false;
        },
        [],
    );

    const onItemsRendered = useCallback(
        (renderedItems: readonly unknown[]) => {
            if (renderedItems.length > 0) {
                settleAtNewestMessage();
            }
        },
        [settleAtNewestMessage],
    );

    const paginationState = loadingHistory ? "loading" : hasMoreHistory ? "idle" : "exhausted";

    if (initializing) {
        return <TimelineSkeleton />;
    }

    if (!items.length) {
        return (
            <div className={classes("timeline-empty")}>
                <div className={classes("empty-orbit")} aria-hidden="true">
                    <span />
                </div>
                <p className={classes("eyebrow")}>NO SIGNALS RECORDED</p>
                <h3>This room contains mostly space.</h3>
                <p>
                    You could leave it pristine, but history suggests someone will type eventually.
                </p>
            </div>
        );
    }

    return (
        <div
            className={classes("timeline")}
            data-ui="timeline"
            aria-label="Room messages"
            aria-busy={loadingHistory}
            data-first-item-index={firstItemIndex}
            data-item-count={items.length}
            data-has-more-history={hasMoreHistory}
            data-scroll-mode={scrollMode}
            data-pagination-state={paginationState}
        >
            <Virtuoso
                key={estimateLayoutRevision}
                data={items}
                firstItemIndex={firstItemIndex}
                alignToBottom
                heightEstimates={itemHeightEstimates}
                computeItemKey={(_index, item) => item.id}
                followOutput={false}
                startReached={() => loadEarlierHistory()}
                scrollerRef={setScroller}
                itemsRendered={onItemsRendered}
                totalListHeightChanged={preserveAttachedBottomAfterTimelineHeightChange}
                increaseViewportBy={TIMELINE_VIEWPORT_PADDING}
                components={TIMELINE_COMPONENTS}
                context={virtuosoContext}
                itemContent={(index, item) => {
                    const itemIndex = index - firstItemIndex;

                    return (
                        <>
                            {item.id === unreadBoundaryId ? (
                                /*
                                 * The divider marks where the reader left off,
                                 * so it stays put once the room is read — but
                                 * it stops claiming the accent, which is
                                 * reserved for what still wants attention.
                                 */
                                <div
                                    className={classes("unread-divider")}
                                    data-unread-state={unreadCount > 0 ? "new" : "read"}
                                    role="separator"
                                >
                                    <span>New</span>
                                </div>
                            ) : null}
                            <MessageRow
                                item={item}
                                next={items[itemIndex + 1]}
                                replyItem={item.replyTo ? itemsById.get(item.replyTo) : undefined}
                                entering={enteringIds.has(item.id)}
                                service={service}
                                onReply={onReply}
                                onEdit={onEdit}
                                onOpenMedia={(mediaItem, opener) => {
                                    lightboxOpener.current = opener;
                                    setLightboxId(mediaItem.id);
                                }}
                            />
                        </>
                    );
                }}
            />
            {lightboxId && imageItems.length ? (
                <Lightbox
                    key={lightboxId}
                    items={imageItems}
                    selectedId={lightboxId}
                    service={service}
                    onSelect={setLightboxId}
                    onClose={closeLightbox}
                />
            ) : null}
        </div>
    );
}
