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
import type { ScrollSeekPlaceholderProps, VirtuosoHandle } from "react-virtuoso";
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
    shouldScrollTimelineToBottom,
    timelineAttachmentAfterBottomStateChange,
} from "@/lib/timeline-scroll";

const EmojiPickerPanel = lazy(() =>
    import("./EmojiPickerPanel").then((module) => ({ default: module.EmojiPickerPanel })),
);
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];
const INITIAL_TIMELINE_LOCATION = { index: "LAST" as const, align: "end" as const };
const TIMELINE_VIEWPORT_PADDING = { top: 600, bottom: 300 };
const TIMELINE_SCROLL_SEEK = {
    enter: (velocity: number) => Math.abs(velocity) > 200,
    exit: (velocity: number) => Math.abs(velocity) < 30,
};
const HISTORY_ANCHOR_MIN_CORRECTION_MS = 400;
const HISTORY_ANCHOR_MAX_CORRECTION_MS = 1_000;
const HISTORY_ANCHOR_STABLE_FRAMES = 8;

interface TimelineVirtuosoContext {
    loadingHistory: boolean;
    hasMoreHistory: boolean;
    requestEarlierHistory: () => void;
}

interface TimelineHistoryAnchor {
    id: string;
    index: number;
    target: "event" | "item";
    top: number;
}

function TimelineHistoryHeader({ context }: { context: TimelineVirtuosoContext }) {
    if (!context.hasMoreHistory) {
        return (
            <div className="history-loader" role="status" aria-live="polite">
                <span className="history-loader__status">Beginning of recorded transmissions</span>
            </div>
        );
    }

    return (
        <div className="history-loader" role="status" aria-live="polite">
            <button
                type="button"
                onClick={context.requestEarlierHistory}
                disabled={context.loadingHistory}
            >
                {context.loadingHistory ? (
                    <LoaderCircle className="spin" aria-hidden="true" />
                ) : (
                    <RefreshCw aria-hidden="true" />
                )}
                {context.loadingHistory
                    ? "Consulting earlier transmissions…"
                    : "Load earlier transmissions"}
            </button>
        </div>
    );
}

function TimelineScrollSeekPlaceholder({ height }: ScrollSeekPlaceholderProps) {
    return (
        <div className="timeline-scroll-seek" style={{ height }} aria-hidden="true">
            <span className="timeline-scroll-seek__avatar" />
            <span className="timeline-scroll-seek__body">
                <i />
                <i />
            </span>
        </div>
    );
}

const TIMELINE_COMPONENTS = {
    Header: TimelineHistoryHeader,
    ScrollSeekPlaceholder: TimelineScrollSeekPlaceholder,
};

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function formatTime(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(
        timestamp,
    );
}

function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
    }).format(timestamp);
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
            className={`animated-image${className ? ` ${className}` : ""}`}
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
                    className="gif-play"
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
                    className={`${visualFrameClass} media-frame--reserved`}
                    style={visualFrameStyle}
                >
                    <div className="media-error media-error--visual">
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
            <div className={`media-error media-error--${item.type}`}>
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
                    className={`${visualFrameClass} media-frame--reserved`}
                    style={visualFrameStyle}
                >
                    <div className="media-loading media-loading--visual">
                        <LoaderCircle className="spin" aria-hidden="true" /> Decrypting attachment…
                    </div>
                </div>
            );
        }

        return (
            <div className={`media-loading media-loading--${item.type}`}>
                <LoaderCircle className="spin" aria-hidden="true" /> Decrypting attachment…
            </div>
        );
    }

    if (item.type === "image") {
        return (
            <div className="image-attachment media-frame--reserved" style={visualFrameStyle}>
                <AnimatedImage
                    item={item}
                    service={service}
                    asset={asset}
                    onOpen={(opener) => onOpen(item, opener)}
                />
                <span className="image-attachment__hint" aria-hidden="true">
                    <Maximize2 />
                    View
                </span>
            </div>
        );
    }

    if (item.type === "video") {
        // Matrix attachments do not include a caption track URL.

        return (
            <div className="video-attachment-frame media-frame--reserved" style={visualFrameStyle}>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video className="video-attachment" src={asset.url} controls preload="metadata" />
            </div>
        );
    }

    if (item.type === "audio") {
        // Matrix attachments do not include a caption track URL.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        return <audio className="audio-attachment" src={asset.url} controls preload="metadata" />;
    }

    return (
        <a href={asset.url} download={item.body} className="file-attachment">
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
            className="reaction-picker"
            role="dialog"
            aria-label={`React to message from ${item.senderName}`}
        >
            <div className="quick-reactions">
                {QUICK_REACTIONS.map((emoji) => (
                    <button type="button" key={emoji} onClick={() => choose(emoji)}>
                        {emoji}
                    </button>
                ))}
            </div>
            <Suspense
                fallback={
                    <div className="emoji-loading">
                        <LoaderCircle className="spin" /> Indexing pictograms…
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
            className="lightbox"
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div
                ref={panel}
                className="lightbox__panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={metadataId}
            >
                <header className="lightbox__header">
                    <div className="lightbox__identity">
                        <strong id={titleId}>{item.body || "Image"}</strong>
                        <span id={metadataId}>
                            {item.senderName} · {formatTime(item.timestamp)}
                        </span>
                    </div>
                    <div className="lightbox__tools" aria-label="Image controls">
                        <button
                            type="button"
                            className={`lightbox__tool lightbox__fit${zoom === MIN_VIEWER_ZOOM ? " is-active" : ""}`}
                            onClick={() => updateZoom(MIN_VIEWER_ZOOM)}
                            aria-label="Fit image to viewer"
                            aria-pressed={zoom === MIN_VIEWER_ZOOM}
                            title="Fit image (0)"
                        >
                            <Maximize2 aria-hidden="true" />
                            <span className="lightbox__tool-label">Fit</span>
                        </button>
                        <div
                            className="lightbox__zoom-controls"
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
                                className="lightbox__zoom-value"
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
                                className="lightbox__tool"
                                href={asset.url}
                                download={item.body || "matrix-image"}
                                aria-label="Download image"
                                title="Download image"
                            >
                                <Download aria-hidden="true" />
                                <span className="lightbox__tool-label">Download</span>
                            </a>
                        ) : null}
                        <button
                            ref={closeButton}
                            type="button"
                            className="lightbox__tool"
                            onClick={onClose}
                            aria-label="Close image viewer"
                            title="Close image viewer"
                        >
                            <X aria-hidden="true" />
                            <span className="lightbox__tool-label">Close</span>
                        </button>
                    </div>
                </header>
                <div
                    ref={stage}
                    className={`lightbox__stage${canPan ? " is-pannable" : ""}${dragging ? " is-dragging" : ""}`}
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
                        <div className="lightbox__error">
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
                        <div className="lightbox__loading">
                            <LoaderCircle className="spin" />
                            Decrypting the full transmission…
                        </div>
                    ) : null}
                    {asset ? (
                        <div
                            className="lightbox__canvas"
                            style={{ width: canvasSize.width, height: canvasSize.height }}
                        >
                            <AnimatedImage
                                item={item}
                                service={service}
                                asset={asset}
                                className="lightbox__image"
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
                            className="lightbox__previous"
                            onClick={() => move(-1)}
                            aria-label="Previous image"
                        >
                            <ChevronLeft />
                        </button>
                        <button
                            type="button"
                            className="lightbox__next"
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
        <div className="day-divider" role="separator">
            <span>{formatDate(timestamp)}</span>
        </div>
    );
}

function PlainMessageBody({ body }: { body: string }) {
    const segments = useMemo(() => messageTextSegments(body), [body]);

    return (
        <p className="message-body">
            {segments.map((segment, index) =>
                segment.href ? (
                    <a
                        key={`${segment.href}-${index}`}
                        href={segment.href}
                        target="_blank"
                        rel="noopener noreferrer"
                    >
                        {segment.text}
                    </a>
                ) : (
                    <Fragment key={index}>{segment.text}</Fragment>
                ),
            )}
        </p>
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
        <div ref={bodyRef} className="formatted-body" dangerouslySetInnerHTML={{ __html: html }} />
    );
}

function MessageRow({
    item,
    previous,
    service,
    onReply,
    onEdit,
    onOpenMedia,
}: {
    item: TimelineItem;
    previous?: TimelineItem;
    service: MatrixService;
    onReply: (item: TimelineItem) => void;
    onEdit: (item: TimelineItem) => void;
    onOpenMedia: (item: TimelineItem, opener: HTMLElement) => void;
}) {
    const [reactionOpen, setReactionOpen] = useState(false);
    const [actionsOpen, setActionsOpen] = useState(false);
    const rowRef = useRef<HTMLElement>(null);
    const newDay = Boolean(
        previous &&
        new Date(previous.timestamp).toDateString() !== new Date(item.timestamp).toDateString(),
    );
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
                {newDay ? <DayDivider timestamp={item.timestamp} /> : null}
                <div className="system-event">
                    <span>{item.body}</span>
                    <time>{formatTime(item.timestamp)}</time>
                </div>
            </>
        );
    }

    return (
        <>
            {newDay ? <DayDivider timestamp={item.timestamp} /> : null}
            <article
                ref={rowRef}
                className={`message-row${item.own ? " message-row--own" : ""}${item.type === "notice" ? " message-row--notice" : ""}${actionsOpen ? " is-actions-open" : ""}`}
                data-event-id={item.id}
                aria-label={`Message from ${item.senderName}`}
            >
                <time
                    className="message-row__time"
                    dateTime={new Date(item.timestamp).toISOString()}
                >
                    {formatTime(item.timestamp)}
                </time>
                <span className="message-row__marker" aria-hidden="true" />
                <div className="message-row__main">
                    <header>
                        <strong>{item.senderName}</strong>
                        {item.edited ? <span className="edited-label">edited</span> : null}
                        {item.encrypted ? (
                            <span className="encrypted-label" title="Encrypted message">
                                E2E
                            </span>
                        ) : null}
                    </header>
                    {item.replyTo ? (
                        <div className="reply-context">
                            <CornerUpLeft aria-hidden="true" />
                            Reply to an earlier transmission
                        </div>
                    ) : null}
                    {item.redacted ? (
                        <p className="redacted-body">Message removed</p>
                    ) : item.decryptionState === "decrypting" ? (
                        <div className="decryption-state" role="status">
                            <LoaderCircle className="spin" aria-hidden="true" />
                            <span>Decrypting transmission…</span>
                        </div>
                    ) : item.decryptionState === "failed" ? (
                        <div className="decryption-state decryption-state--failed" role="status">
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
                        <div className="reaction-list" aria-label="Reactions">
                            {item.reactions.map((reaction) => (
                                <button
                                    key={reaction.key}
                                    type="button"
                                    className={reaction.mine ? "is-mine" : ""}
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
                        <div className={`send-status send-status--${item.sendingStatus}`}>
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
                        <div className="read-receipt">
                            <CheckCheck aria-hidden="true" />
                            Read by {item.readBy.join(", ")}
                        </div>
                    ) : null}
                </div>
                {actionable ? (
                    <button
                        type="button"
                        className="message-actions-toggle"
                        aria-label={`Show actions for message from ${item.senderName}`}
                        aria-expanded={actionsOpen}
                        onClick={() => setActionsOpen((open) => !open)}
                    >
                        <MoreHorizontal />
                    </button>
                ) : null}
                {actionable ? (
                    <div
                        className="message-actions"
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
    const [hasRenderedItems, setHasRenderedItems] = useState(false);
    const lightboxOpener = useRef<HTMLElement | null>(null);
    const virtuoso = useRef<VirtuosoHandle>(null);
    const scroller = useRef<HTMLElement | null>(null);
    const removeScrollerListeners = useRef<(() => void) | null>(null);
    const attachedToBottom = useRef(true);
    const previousItems = useRef<Array<{ id: string; own: boolean }>>([]);
    const previousFirstItemIndex = useRef(firstItemIndex);
    const lastScrollMetrics = useRef({ top: 0, height: 0 });
    const historyAnchor = useRef<TimelineHistoryAnchor | null>(null);
    const historyAnchorCaptureFrame = useRef<number | null>(null);
    const historyAnchorFrame = useRef<number | null>(null);
    const historyPaginationSettling = useRef(false);
    const touchY = useRef<number | null>(null);
    const pointerGesture = useRef<{ id: number; y: number } | null>(null);
    const bottomFrame = useRef<number | null>(null);
    const programmaticResetFrame = useRef<number | null>(null);
    const forcePendingBottom = useRef(false);
    const programmaticScroll = useRef(false);
    const imageItems = useMemo(
        () => items.filter((item) => item.type === "image" && item.media && !item.redacted),
        [items],
    );
    const firstTimelineItemId = items[0]?.id;
    const loadEarlierHistory = useCallback(() => {
        if (!hasMoreHistory || loadingHistory || historyPaginationSettling.current) {
            return;
        }

        const anchorElement = firstTimelineItemId
            ? [...(scroller.current?.querySelectorAll<HTMLElement>("[data-event-id]") ?? [])].find(
                  (element) => element.dataset.eventId === firstTimelineItemId,
              )
            : null;
        const itemElement = scroller.current?.querySelector<HTMLElement>(
            `[data-index="${firstItemIndex}"]`,
        );

        historyAnchor.current =
            firstTimelineItemId && anchorElement
                ? {
                      id: firstTimelineItemId,
                      index: firstItemIndex,
                      target: "event",
                      top: anchorElement.getBoundingClientRect().top,
                  }
                : firstTimelineItemId && itemElement
                  ? {
                        id: firstTimelineItemId,
                        index: firstItemIndex,
                        target: "item",
                        top: itemElement.getBoundingClientRect().top,
                    }
                  : null;
        historyPaginationSettling.current = true;
        const requestedFirstItemIndex = firstItemIndex;

        const captureRenderedAnchor = () => {
            historyAnchorCaptureFrame.current = null;

            if (
                !historyPaginationSettling.current ||
                previousFirstItemIndex.current !== requestedFirstItemIndex
            ) {
                return;
            }

            const renderedAnchor = firstTimelineItemId
                ? [
                      ...(scroller.current?.querySelectorAll<HTMLElement>("[data-event-id]") ?? []),
                  ].find((element) => element.dataset.eventId === firstTimelineItemId)
                : null;

            if (renderedAnchor && firstTimelineItemId) {
                historyAnchor.current = {
                    id: firstTimelineItemId,
                    index: requestedFirstItemIndex,
                    target: "event",
                    top: renderedAnchor.getBoundingClientRect().top,
                };
            }

            historyAnchorCaptureFrame.current = window.requestAnimationFrame(captureRenderedAnchor);
        };

        historyAnchorCaptureFrame.current = window.requestAnimationFrame(captureRenderedAnchor);

        void service.paginate().finally(() => {
            window.requestAnimationFrame(() => {
                if (
                    historyAnchorFrame.current === null &&
                    previousFirstItemIndex.current === requestedFirstItemIndex
                ) {
                    if (historyAnchorCaptureFrame.current !== null) {
                        window.cancelAnimationFrame(historyAnchorCaptureFrame.current);
                        historyAnchorCaptureFrame.current = null;
                    }

                    historyAnchor.current = null;
                    historyPaginationSettling.current = false;
                }
            });
        });
    }, [firstItemIndex, firstTimelineItemId, hasMoreHistory, loadingHistory, service]);

    const virtuosoContext = useMemo(
        () => ({ loadingHistory, hasMoreHistory, requestEarlierHistory: loadEarlierHistory }),
        [hasMoreHistory, loadEarlierHistory, loadingHistory],
    );

    const restoreHistoryAnchor = useCallback(() => {
        if (historyAnchorCaptureFrame.current !== null) {
            window.cancelAnimationFrame(historyAnchorCaptureFrame.current);
            historyAnchorCaptureFrame.current = null;
        }

        if (historyAnchorFrame.current !== null) {
            window.cancelAnimationFrame(historyAnchorFrame.current);
        }

        const startedAt = window.performance.now();
        let stableFrames = 0;

        const restore = () => {
            historyAnchorFrame.current = null;
            const element = scroller.current;
            const anchor = historyAnchor.current;

            if (!element || !anchor) {
                historyAnchor.current = null;
                historyPaginationSettling.current = false;

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
            const needsMoreTime = elapsed < HISTORY_ANCHOR_MIN_CORRECTION_MS;
            const needsStableFrames = stableFrames < HISTORY_ANCHOR_STABLE_FRAMES;

            if (
                elapsed < HISTORY_ANCHOR_MAX_CORRECTION_MS &&
                (needsMoreTime || needsStableFrames)
            ) {
                historyAnchorFrame.current = window.requestAnimationFrame(restore);

                return;
            }

            historyAnchor.current = null;
            historyPaginationSettling.current = false;
            programmaticScroll.current = false;
        };

        historyAnchorFrame.current = window.requestAnimationFrame(restore);
    }, []);

    const closeLightbox = () => {
        setLightboxId(null);
        window.requestAnimationFrame(() => lightboxOpener.current?.focus());
    };

    const detachFromBottom = useCallback(() => {
        attachedToBottom.current = false;
    }, []);

    const scheduleBottomPosition = useCallback((force = false) => {
        forcePendingBottom.current ||= force;

        if (bottomFrame.current !== null) {
            return;
        }

        bottomFrame.current = window.requestAnimationFrame(() => {
            bottomFrame.current = null;
            const forced = forcePendingBottom.current;

            forcePendingBottom.current = false;

            if (!forced && !attachedToBottom.current) {
                return;
            }

            programmaticScroll.current = true;
            virtuoso.current?.scrollToIndex(INITIAL_TIMELINE_LOCATION);

            if (programmaticResetFrame.current !== null) {
                window.cancelAnimationFrame(programmaticResetFrame.current);
            }

            programmaticResetFrame.current = window.requestAnimationFrame(() => {
                programmaticScroll.current = false;
                programmaticResetFrame.current = null;
            });
        });
    }, []);

    const setScroller = useCallback(
        (value: HTMLElement | Window | null) => {
            removeScrollerListeners.current?.();
            removeScrollerListeners.current = null;
            scroller.current = value instanceof HTMLElement ? value : null;
            const element = scroller.current;

            if (!element) {
                return;
            }

            lastScrollMetrics.current = { top: element.scrollTop, height: element.scrollHeight };

            const onScroll = () => {
                const nextTop = element.scrollTop;
                const nextHeight = element.scrollHeight;
                const previous = lastScrollMetrics.current;
                const atBottom = nextHeight - element.clientHeight - nextTop <= 2;

                if (atBottom) {
                    attachedToBottom.current = true;
                } else if (
                    !programmaticScroll.current &&
                    nextHeight === previous.height &&
                    nextTop < previous.top - 1
                ) {
                    detachFromBottom();
                }

                lastScrollMetrics.current = { top: nextTop, height: nextHeight };
            };

            const onWheel = (event: WheelEvent) => {
                if (event.deltaY < 0) {
                    detachFromBottom();
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

                if (touchY.current !== null && nextY > touchY.current + 3) {
                    detachFromBottom();
                }

                touchY.current = nextY;
            };

            const clearTouch = () => {
                touchY.current = null;
            };

            const onPointerDown = (event: PointerEvent) => {
                if (event.pointerType === "mouse") {
                    return;
                }

                pointerGesture.current = { id: event.pointerId, y: event.clientY };
            };

            const onPointerMove = (event: PointerEvent) => {
                const current = pointerGesture.current;

                if (!current || current.id !== event.pointerId) {
                    return;
                }

                if (event.clientY > current.y + 3) {
                    detachFromBottom();
                }

                pointerGesture.current = { id: event.pointerId, y: event.clientY };
            };

            const clearPointer = (event: PointerEvent) => {
                if (pointerGesture.current?.id === event.pointerId) {
                    pointerGesture.current = null;
                }
            };

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

            removeScrollerListeners.current = () => {
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
            };
        },
        [detachFromBottom],
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

            if (upwardKey && scroller.current) {
                detachFromBottom();
            }
        };

        window.addEventListener("keydown", onKeyDown);

        return () => window.removeEventListener("keydown", onKeyDown);
    }, [detachFromBottom]);

    useLayoutEffect(() => {
        const nextItems = items.map((item) => ({ id: item.id, own: item.own }));
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
            if (historyAnchor.current) {
                restoreHistoryAnchor();
            } else {
                historyPaginationSettling.current = false;
            }
        } else if (change.kind === "replace" && historyPaginationSettling.current) {
            if (historyAnchorCaptureFrame.current !== null) {
                window.cancelAnimationFrame(historyAnchorCaptureFrame.current);
                historyAnchorCaptureFrame.current = null;
            }

            if (historyAnchorFrame.current !== null) {
                window.cancelAnimationFrame(historyAnchorFrame.current);
                historyAnchorFrame.current = null;
            }

            historyAnchor.current = null;
            historyPaginationSettling.current = false;
            programmaticScroll.current = false;
        }

        if (change.kind === "initial") {
            attachedToBottom.current = true;

            return;
        }

        if (!shouldScrollTimelineToBottom(change, attachedToBottom.current)) {
            return;
        }

        const force = change.kind === "replace" || change.appendedOwnItem;

        if (force) {
            attachedToBottom.current = true;
        }

        scheduleBottomPosition(force);
    }, [firstItemIndex, items, restoreHistoryAnchor, scheduleBottomPosition]);

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

            if (historyAnchorCaptureFrame.current !== null) {
                window.cancelAnimationFrame(historyAnchorCaptureFrame.current);
            }

            historyAnchor.current = null;
            historyAnchorCaptureFrame.current = null;
            historyPaginationSettling.current = false;
            programmaticScroll.current = false;
        },
        [],
    );

    const onAtBottomStateChange = useCallback((atBottom: boolean) => {
        attachedToBottom.current = timelineAttachmentAfterBottomStateChange(
            attachedToBottom.current,
            atBottom,
        );
    }, []);

    const onTotalListHeightChanged = useCallback(() => {
        if (attachedToBottom.current) {
            scheduleBottomPosition();
        }
    }, [scheduleBottomPosition]);

    const onItemsRendered = useCallback((renderedItems: readonly unknown[]) => {
        const next = renderedItems.length > 0;

        setHasRenderedItems((current) => (current === next ? current : next));
    }, []);

    if (initializing) {
        return (
            <div
                className="timeline-empty timeline-loading"
                role="status"
                aria-live="polite"
                aria-busy="true"
            >
                <LoaderCircle className="spin" aria-hidden="true" />
                <p className="eyebrow">TUNING ROOM HISTORY</p>
                <h3>Resolving local signals.</h3>
                <p>Loading messages and the encryption keys needed to read them…</p>
            </div>
        );
    }

    if (!items.length) {
        return (
            <div className="timeline-empty">
                <div className="empty-orbit" aria-hidden="true">
                    <span />
                </div>
                <p className="eyebrow">NO SIGNALS RECORDED</p>
                <h3>This room contains mostly space.</h3>
                <p>
                    You could leave it pristine, but history suggests someone will type eventually.
                </p>
            </div>
        );
    }

    return (
        <div
            className="timeline"
            aria-label="Room messages"
            aria-busy={loadingHistory}
            data-first-item-index={firstItemIndex}
            data-item-count={items.length}
            data-has-more-history={hasMoreHistory}
        >
            <Virtuoso
                ref={virtuoso}
                data={items}
                firstItemIndex={firstItemIndex}
                initialTopMostItemIndex={INITIAL_TIMELINE_LOCATION}
                alignToBottom
                defaultItemHeight={96}
                computeItemKey={(_index, item) => item.id}
                followOutput={false}
                startReached={loadEarlierHistory}
                atBottomStateChange={onAtBottomStateChange}
                scrollerRef={setScroller}
                totalListHeightChanged={onTotalListHeightChanged}
                itemsRendered={onItemsRendered}
                scrollSeekConfiguration={TIMELINE_SCROLL_SEEK}
                increaseViewportBy={TIMELINE_VIEWPORT_PADDING}
                components={TIMELINE_COMPONENTS}
                context={virtuosoContext}
                itemContent={(index, item) => {
                    const itemIndex = index - firstItemIndex;

                    return (
                        <>
                            {unreadCount > 0 &&
                            itemIndex === Math.max(0, items.length - unreadCount) ? (
                                <div className="unread-divider" role="separator">
                                    <span>New transmissions</span>
                                </div>
                            ) : null}
                            <MessageRow
                                item={item}
                                previous={items[itemIndex - 1]}
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
            {!hasRenderedItems ? (
                <div className="timeline-measuring" aria-hidden="true">
                    <TimelineScrollSeekPlaceholder height={96} index={0} type="item" />
                    <TimelineScrollSeekPlaceholder height={96} index={1} type="item" />
                    <span>Measuring room history…</span>
                </div>
            ) : null}
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
