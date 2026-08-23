"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
    ChevronLeft,
    ChevronRight,
    Download,
    LoaderCircle,
    Maximize2,
    RefreshCw,
    ShieldAlert,
    X,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
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
import type { TimelineItem } from "@/lib/matrix/types";
import { classes } from "../../styles/appStyles";
import { AnimatedImage, useTimelineMedia } from "./Media";
import { formatTime } from "./utils";

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

export function Lightbox({
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
