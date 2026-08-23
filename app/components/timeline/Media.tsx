"use client";

import { useEffect, useState } from "react";
import {
    Download,
    FileText,
    LoaderCircle,
    Maximize2,
    Play,
    RefreshCw,
    ShieldAlert,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import { MediaLimitError } from "@/lib/matrix/media";
import { type ViewerSize } from "@/lib/image-viewer";
import type { MediaAsset, TimelineItem } from "@/lib/matrix/types";
import { classes } from "../../styles/appStyles";
import { formatSize, timelineVisualFrameStyle } from "./utils";

export function useTimelineMedia(item: TimelineItem, service: MatrixService, retryToken = 0) {
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

export function AnimatedImage({
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

export function MediaAttachment({
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
