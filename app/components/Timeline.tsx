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
    MoreHorizontal,
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
    preserveScrollCenter,
    stepViewerZoom,
    type ViewerSize,
} from "@/lib/image-viewer";
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
import { classes } from "../styles/appStyles";

const EmojiPickerPanel = lazy(() =>
    import("./EmojiPickerPanel").then((module) => ({ default: module.EmojiPickerPanel })),
);
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
const TIMELINE_VIEWPORT_PADDING = { top: 0, bottom: 300 };
const TIMELINE_COMPACT_BREAKPOINT_PX = 720;
const TIMELINE_ESTIMATED_MEDIA_GUTTER_PX = 70;
const TIMELINE_MAX_ESTIMATED_MEDIA_WIDTH_PX = 520;
const HISTORY_ANCHOR_MIN_SETTLE_MS = 120;
const HISTORY_ANCHOR_MAX_SETTLE_MS = 600;
const HISTORY_ANCHOR_STABLE_FRAMES = 4;
const USER_SCROLL_END_DELAY_MS = 160;

type UserScrollDirection = -1 | 0 | 1;

const AUTHOR_ACCENTS = [
    "var(--participant-steel)",
    "var(--participant-sage)",
    "var(--participant-orchid)",
    "var(--participant-clay)",
    "var(--participant-sand)",
] as const;

type AuthorAccentStyle = CSSProperties & { "--author-accent": string };

function getAuthorAccentStyle(senderId: string, own: boolean): AuthorAccentStyle {
    if (own) {
        return { "--author-accent": "var(--ink)" };
    }

    const localpart = senderId.startsWith("@")
        ? (senderId.slice(1).split(":", 1)[0] ?? senderId)
        : senderId;
    let hash = 0;

    for (let index = 0; index < localpart.length; index += 1) {
        hash = (hash * 31 + localpart.charCodeAt(index)) >>> 0;
    }

    return { "--author-accent": AUTHOR_ACCENTS[hash % AUTHOR_ACCENTS.length] };
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
    const textHeight = (compact ? 66 : 82) + estimatedTextLines * (compact ? 25.2 : 27.52);
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

function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const today = new Date();

    if (
        date.getFullYear() === today.getFullYear() &&
        date.getMonth() === today.getMonth() &&
        date.getDate() === today.getDate()
    ) {
        return "Today";
    }

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
        if (visual) {
            return (
                <div
                    className={classes(`${visualFrameClass} media-frame--reserved`)}
                    style={visualFrameStyle}
                >
                    <div className={classes("media-loading media-loading--visual")}>
                        <LoaderCircle className={classes("spin")} aria-hidden="true" /> Decrypting
                        attachment…
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

    const updateZoom = useCallback(
        (nextZoom: number) => {
            const clamped = clampViewerZoom(nextZoom);

            if (clamped === zoom) {
                return;
            }

            if (stage.current) {
                pendingCenter.current = readViewerScrollMetrics(stage.current);
            }

            setZoom(clamped);
        },
        [zoom],
    );

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
                            !canPan ||
                            event.button !== 0 ||
                            (event.target as HTMLElement).closest("button, a")
                        ) {
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
                        const drag = dragState.current;

                        if (!drag || drag.pointerId !== event.pointerId) {
                            return;
                        }

                        event.currentTarget.scrollLeft =
                            drag.scrollLeft - (event.clientX - drag.startX);
                        event.currentTarget.scrollTop =
                            drag.scrollTop - (event.clientY - drag.startY);
                    }}
                    onPointerUp={finishPan}
                    onPointerCancel={finishPan}
                    onLostPointerCapture={() => {
                        dragState.current = null;
                        setDragging(false);
                    }}
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
            <span>{formatDate(timestamp)}</span>
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

function FormattedMessageBody({ html }: { html: string }) {
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

function replyExcerpt(item: TimelineItem): string {
    const firstLine = item.body.split("\n", 1)[0] ?? item.body;

    return firstLine.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? firstLine;
}

function MessageRow({
    item,
    next,
    replyItem,
    service,
    onReply,
    onEdit,
    onOpenMedia,
}: {
    item: TimelineItem;
    next?: TimelineItem;
    replyItem?: TimelineItem;
    service: MatrixService;
    onReply: (item: TimelineItem) => void;
    onEdit: (item: TimelineItem) => void;
    onOpenMedia: (item: TimelineItem, opener: HTMLElement) => void;
}) {
    const [reactionOpen, setReactionOpen] = useState(false);
    const [actionsOpen, setActionsOpen] = useState(false);
    const rowRef = useRef<HTMLElement>(null);
    const nextDay =
        next && new Date(next.timestamp).toDateString() !== new Date(item.timestamp).toDateString();
    const actionable = item.decryptionState === "ready" && !item.redacted && !item.sendingStatus;
    const editable = actionable && item.own && item.type === "message" && !item.media;

    useEffect(() => {
        if (!actionsOpen) {
            return;
        }

        const dismiss = (event: PointerEvent) => {
            if (!rowRef.current?.contains(event.target as Node)) {
                setActionsOpen(false);
                setReactionOpen(false);
            }
        };

        const escape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setActionsOpen(false);
                setReactionOpen(false);
            }
        };

        document.addEventListener("pointerdown", dismiss);
        window.addEventListener("keydown", escape);

        return () => {
            document.removeEventListener("pointerdown", dismiss);
            window.removeEventListener("keydown", escape);
        };
    }, [actionsOpen]);

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
                    `message-row${item.own ? " message-row--own" : ""}${item.type === "notice" ? " message-row--notice" : ""}${next ? "" : " message-row--last"}${actionsOpen ? " is-actions-open" : ""}`,
                )}
                style={getAuthorAccentStyle(item.senderId, item.own)}
                data-ui="message-row"
                data-actions-state={actionsOpen ? "open" : "closed"}
                data-event-id={item.id}
                aria-label={`Message from ${item.senderName}`}
            >
                <time
                    className={classes("message-row__time")}
                    dateTime={new Date(item.timestamp).toISOString()}
                >
                    {formatTime(item.timestamp)}
                </time>
                <span className={classes("message-row__marker")} aria-hidden="true" />
                <div className={classes("message-row__main")}>
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
                                    aria-pressed={reaction.mine}
                                    onClick={() =>
                                        void service.toggleReaction(item.id, reaction.key)
                                    }
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
                    <button
                        type="button"
                        className={classes("message-actions-toggle")}
                        data-ui="message-actions-toggle"
                        aria-label={`Show actions for message from ${item.senderName}`}
                        aria-expanded={actionsOpen}
                        onClick={() => setActionsOpen((open) => !open)}
                    >
                        <MoreHorizontal />
                    </button>
                ) : null}
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
                                setActionsOpen(false);
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
                            onClick={() => setReactionOpen((open) => !open)}
                        >
                            <SmilePlus />
                        </button>
                        {editable ? (
                            <button
                                type="button"
                                title="Edit"
                                aria-label="Edit"
                                onClick={() => {
                                    setActionsOpen(false);
                                    onEdit(item);
                                }}
                            >
                                <Pencil />
                            </button>
                        ) : null}
                        {item.own ? (
                            <button
                                type="button"
                                title="Remove"
                                aria-label="Remove"
                                onClick={() => {
                                    setActionsOpen(false);
                                    void service.redact(item.id);
                                }}
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
    const programmaticResetFrame = useRef<number | null>(null);
    const forcePendingBottom = useRef(false);
    const programmaticScroll = useRef(false);
    const userScrollActive = useRef(false);
    const userScrollEndTimer = useRef<number | null>(null);
    const userScrollEndFrame = useRef<number | null>(null);
    const finishUserScrollRef = useRef<() => void>(() => undefined);
    const userScrollDirection = useRef<UserScrollDirection>(0);
    const olderIntentLatched = useRef(false);
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
                .map(
                    (item) =>
                        `${item.id}:${item.type}:${item.media ? `${item.media.width ?? "?"}x${item.media.height ?? "?"}` : "none"}`,
                )
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
    const loadEarlierHistory = useCallback(() => {
        if (
            scrollModeRef.current === "initializing" ||
            !hasMoreHistory ||
            loadingHistory ||
            historyRequestInFlight.current
        ) {
            return;
        }

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
                              left.getBoundingClientRect().top - right.getBoundingClientRect().top,
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
            window.requestAnimationFrame(() => {
                if (previousFirstItemIndex.current === requestedFirstItemIndex) {
                    historyAnchor.current = null;
                    historyRestoreDeferred.current = false;

                    if (scrollModeRef.current === "restoring-history") {
                        transitionScrollMode({ type: "history-complete" });
                    }

                    if (scrollModeRef.current !== "attached" && !userScrollActive.current) {
                        captureDetachedAnchor();
                    }
                }
            });
        });
    }, [
        cancelHistoryRestoration,
        captureDetachedAnchor,
        firstItemIndex,
        hasMoreHistory,
        items,
        loadingHistory,
        service,
        transitionScrollMode,
    ]);

    const firstTimestamp = items[0]?.timestamp ?? null;
    const virtuosoContext = useMemo(
        () => ({
            loadingHistory,
            hasMoreHistory,
            firstTimestamp,
            requestEarlierHistory: loadEarlierHistory,
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
                ? element.scrollHeight - element.clientHeight - element.scrollTop <= 2
                : false;
            const direction = userScrollDirection.current;
            const hadOlderIntent = olderIntentLatched.current;
            const restoreDeferredHistory =
                historyRestoreDeferred.current && historyAnchor.current !== null;

            userScrollActive.current = false;
            userScrollDirection.current = 0;
            olderIntentLatched.current = false;

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

        if (bottomFrame.current !== null) {
            window.cancelAnimationFrame(bottomFrame.current);
            bottomFrame.current = null;
        }

        if (programmaticResetFrame.current !== null) {
            window.cancelAnimationFrame(programmaticResetFrame.current);
            programmaticResetFrame.current = null;
        }

        if (detachedRestoreFrame.current !== null) {
            window.cancelAnimationFrame(detachedRestoreFrame.current);
            detachedRestoreFrame.current = null;
        }

        forcePendingBottom.current = false;
        programmaticScroll.current = false;
        detachedViewportAnchor.current = null;

        transitionScrollMode({ type: "user-detach" });
    }, [beginUserScroll, transitionScrollMode]);

    const scheduleBottomPosition = useCallback(
        (force = false, immediate = false) => {
            forcePendingBottom.current ||= force;

            const position = () => {
                bottomFrame.current = null;
                const forced = forcePendingBottom.current;
                const mode = scrollModeRef.current;

                forcePendingBottom.current = false;

                if (userScrollActive.current && mode !== "attached") {
                    return;
                }

                if (forced ? mode !== "initializing" && mode !== "attached" : mode !== "attached") {
                    return;
                }

                const element = scroller.current;

                if (!element) {
                    return;
                }

                programmaticScroll.current = true;
                element.scrollTo({ top: element.scrollHeight, behavior: "auto" });

                if (programmaticResetFrame.current !== null) {
                    window.cancelAnimationFrame(programmaticResetFrame.current);
                }

                programmaticResetFrame.current = window.requestAnimationFrame(() => {
                    programmaticScroll.current = false;
                    programmaticResetFrame.current = null;

                    if (scrollModeRef.current === "initializing") {
                        transitionScrollMode({ type: "initial-positioned" });
                    }
                });
            };

            if (immediate) {
                if (bottomFrame.current !== null) {
                    window.cancelAnimationFrame(bottomFrame.current);
                }

                position();

                return;
            }

            if (bottomFrame.current !== null) {
                return;
            }

            bottomFrame.current = window.requestAnimationFrame(position);
        },
        [transitionScrollMode],
    );

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
        if (!userScrollActive.current && scrollModeRef.current === "attached") {
            scheduleBottomPosition();
        }
    }, [scheduleBottomPosition]);

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
                    element.scrollHeight - element.clientHeight - element.scrollTop <= 2;

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
            detachedViewportAnchor.current = null;

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
            programmaticScroll.current = false;
        }

        if (change.kind === "initial") {
            scheduleBottomPosition(true, true);

            return;
        }

        if (!shouldFollowTimelineChange(change, scrollMode)) {
            if (scrollMode === "detached") {
                scheduleDetachedAnchorRestore();
            }

            return;
        }

        const wasAttachedRemoteAppend = change.kind === "append" && scrollMode === "attached";
        const force = change.appendedLocalItem;

        if (change.appendedLocalItem) {
            cancelHistoryRestoration();
            transitionScrollMode({ type: "local-append" });
        } else if (wasAttachedRemoteAppend) {
            transitionScrollMode({ type: "bottom-state", atBottom: true });
        }

        scheduleBottomPosition(force);
    }, [
        cancelHistoryRestoration,
        firstItemIndex,
        items,
        restoreHistoryAnchor,
        scheduleBottomPosition,
        scheduleDetachedAnchorRestore,
        scrollMode,
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
            programmaticScroll.current = false;
            userScrollActive.current = false;
        },
        [],
    );

    const onItemsRendered = useCallback(
        (renderedItems: readonly unknown[]) => {
            if (renderedItems.length > 0 && scrollModeRef.current === "initializing") {
                scheduleBottomPosition(true);
            }
        },
        [scheduleBottomPosition],
    );

    const paginationState = loadingHistory ? "loading" : hasMoreHistory ? "idle" : "exhausted";

    if (initializing) {
        return (
            <div
                className={classes("timeline-empty timeline-loading")}
                role="status"
                aria-live="polite"
                aria-busy="true"
            >
                <LoaderCircle className={classes("spin")} aria-hidden="true" />
                <p className={classes("eyebrow")}>TUNING ROOM HISTORY</p>
                <h3>Resolving local signals.</h3>
                <p>Loading messages and the encryption keys needed to read them…</p>
            </div>
        );
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
                startReached={loadEarlierHistory}
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
                                <div className={classes("unread-divider")} role="separator">
                                    <span>New</span>
                                </div>
                            ) : null}
                            <MessageRow
                                item={item}
                                next={items[itemIndex + 1]}
                                replyItem={item.replyTo ? itemsById.get(item.replyTo) : undefined}
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
