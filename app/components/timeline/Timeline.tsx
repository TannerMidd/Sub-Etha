"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { ListItem, VirtuosoHandle } from "react-virtuoso";
import type { MatrixService } from "@/lib/matrix/client";
import type { TimelineItem } from "@/lib/matrix/types";
import {
    classifyTimelineChange,
    shouldFollowTimelineChange,
    transitionTimelineScrollMode,
    type TimelineIdentity,
    type TimelineScrollEvent,
    type TimelineScrollMode,
} from "@/lib/timeline-scroll";
import { classes } from "../../styles/appStyles";
import { TIMELINE_COMPONENTS, TimelineSkeleton, type TimelineVirtuosoContext } from "./Chrome";
import { Lightbox } from "./Lightbox";
import { MessageRow } from "./MessageRow";
import {
    ENTER_ANIMATION_MS,
    estimateTimelineItemHeight,
    initialUnreadBoundaryId,
    KNOWN_ITEM_ID_LIMIT,
    NO_ENTERING_ITEMS,
    TIMELINE_BOTTOM_TOLERANCE_PX,
    TIMELINE_VIEWPORT_PADDING,
    timelineEntranceIdentity,
} from "./utils";

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
    const virtuosoRef = useRef<VirtuosoHandle | null>(null);
    const scrollerElement = useRef<HTMLElement | null>(null);
    const removeScrollerListener = useRef<(() => void) | null>(null);
    const scrollerResizeObserver = useRef<ResizeObserver | null>(null);
    const scrollerResizeFrame = useRef<number | null>(null);
    const scrollModeRef = useRef<TimelineScrollMode>("initializing");
    const previousItems = useRef<TimelineIdentity[]>([]);
    const previousFirstItemIndex = useRef(firstItemIndex);
    const historyRequestInFlight = useRef(false);
    const unreadBoundaryInitialized = useRef(items.length > 0 || !initializing);
    const transitionScrollMode = useCallback((event: TimelineScrollEvent) => {
        const nextMode = transitionTimelineScrollMode(scrollModeRef.current, event);

        scrollModeRef.current = nextMode;
        setScrollMode((current) => (current === nextMode ? current : nextMode));
    }, []);
    const scrollToNewest = useCallback(() => {
        virtuosoRef.current?.scrollToIndex({
            index: "LAST",
            align: "end",
            behavior: "auto",
        });
    }, []);
    const handleBottomStateChange = useCallback(
        (atBottom: boolean) => {
            // A true value is useful when a short list needs no physical scroll.
            // Detachment is classified by the native scroll event below so it is
            // immediate rather than waiting for Virtuoso's throttled callback.
            if (atBottom && scrollModeRef.current === "initializing") {
                transitionScrollMode({ type: "bottom-state", atBottom: true });

                return;
            }

            if (!atBottom && scrollModeRef.current === "attached") {
                // Row or viewport geometry grew while the reader remained at
                // the live edge. Ask Virtuoso to reconcile its own measurement;
                // native upward scrolling has already switched to detached.
                scrollToNewest();
            }
        },
        [scrollToNewest, transitionScrollMode],
    );
    const setScroller = useCallback(
        (value: HTMLElement | Window | null) => {
            removeScrollerListener.current?.();
            removeScrollerListener.current = null;
            scrollerResizeObserver.current?.disconnect();
            scrollerResizeObserver.current = null;

            if (scrollerResizeFrame.current !== null) {
                window.cancelAnimationFrame(scrollerResizeFrame.current);
                scrollerResizeFrame.current = null;
            }

            scrollerElement.current = null;

            if (!(value instanceof HTMLElement)) {
                return;
            }

            scrollerElement.current = value;
            let previousScrollTop = value.scrollTop;

            const handleScroll = () => {
                const currentScrollTop = value.scrollTop;
                const atBottom =
                    value.scrollHeight - value.clientHeight - currentScrollTop <=
                    TIMELINE_BOTTOM_TOLERANCE_PX;

                if (atBottom) {
                    transitionScrollMode({ type: "bottom-state", atBottom: true });
                } else if (
                    scrollModeRef.current !== "initializing" &&
                    currentScrollTop < previousScrollTop
                ) {
                    if (scrollerResizeFrame.current !== null) {
                        window.cancelAnimationFrame(scrollerResizeFrame.current);
                        scrollerResizeFrame.current = null;
                    }

                    // Moving upward from the live edge is the only scroll that
                    // detaches. Downward Virtuoso navigation (initial open or a
                    // local send) stays attached until it reaches the bottom. It
                    // also cancels a pending viewport follow so a resize cannot
                    // pull against the reader's movement on the next frame.
                    transitionScrollMode({ type: "bottom-state", atBottom: false });
                }

                previousScrollTop = currentScrollTop;
            };

            value.addEventListener("scroll", handleScroll, { passive: true });
            removeScrollerListener.current = () =>
                value.removeEventListener("scroll", handleScroll);

            if (typeof ResizeObserver !== "undefined") {
                const observer = new ResizeObserver(() => {
                    if (
                        scrollModeRef.current === "attached" &&
                        scrollerResizeFrame.current === null
                    ) {
                        // Let Virtuoso consume the same resize notification before
                        // asking it to reposition. This coalesces composer/mobile
                        // viewport changes into one library-owned movement.
                        scrollerResizeFrame.current = window.requestAnimationFrame(() => {
                            scrollerResizeFrame.current = null;

                            if (scrollModeRef.current === "attached") {
                                scrollToNewest();
                            }
                        });
                    }
                });

                observer.observe(value);
                scrollerResizeObserver.current = observer;
            }
        },
        [scrollToNewest, transitionScrollMode],
    );
    const handleItemsRendered = useCallback(
        (renderedItems: ListItem<TimelineItem>[]) => {
            if (renderedItems.length === 0 || scrollModeRef.current !== "initializing") {
                return;
            }

            scrollToNewest();

            const element = scrollerElement.current;
            const newestId = items.at(-1)?.id;
            const newestIsRendered = renderedItems.some((item) => item.data?.id === newestId);

            // Short conversations may already fit without producing a scroll
            // event. Only trust physical state after Virtuoso has rendered the
            // newest item; its provisional first-frame scroll height is otherwise
            // indistinguishable from a genuinely short list.
            if (
                element &&
                newestIsRendered &&
                element.scrollHeight - element.clientHeight - element.scrollTop <=
                    TIMELINE_BOTTOM_TOLERANCE_PX
            ) {
                transitionScrollMode({ type: "bottom-state", atBottom: true });
            }
        },
        [items, scrollToNewest, transitionScrollMode],
    );
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

            if (!fromUserGesture && scrollModeRef.current !== "detached") {
                return;
            }

            historyRequestInFlight.current = true;

            void service.paginate().finally(() => {
                historyRequestInFlight.current = false;
            });
        },
        [hasMoreHistory, loadingHistory, service],
    );

    const firstTimestamp = items[0]?.timestamp ?? null;
    const virtuosoContext = useMemo<TimelineVirtuosoContext>(
        () => ({
            loadingHistory,
            hasMoreHistory,
            firstTimestamp,
            requestEarlierHistory: () => loadEarlierHistory(true),
        }),
        [firstTimestamp, hasMoreHistory, loadEarlierHistory, loadingHistory],
    );

    const closeLightbox = () => {
        setLightboxId(null);
        window.requestAnimationFrame(() => lightboxOpener.current?.focus());
    };

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
         * too, but Virtuoso is preserving the reading position while those rows
         * are measured. Keeping prepended rows motionless avoids mixing entrance
         * transforms with that single measurement authority.
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
            removeScrollerListener.current?.();
            removeScrollerListener.current = null;
            scrollerResizeObserver.current?.disconnect();
            scrollerResizeObserver.current = null;

            if (scrollerResizeFrame.current !== null) {
                window.cancelAnimationFrame(scrollerResizeFrame.current);
                scrollerResizeFrame.current = null;
            }

            scrollerElement.current = null;
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

        if (change.kind === "initial") {
            return;
        }

        if (!shouldFollowTimelineChange(change, scrollMode)) {
            return;
        }

        if (change.appendedLocalItem) {
            transitionScrollMode({ type: "local-append" });
            scrollToNewest();

            return;
        }

        if (scrollMode === "attached") {
            scrollToNewest();
        }
    }, [firstItemIndex, items, scrollToNewest, scrollMode, transitionScrollMode]);

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
                ref={virtuosoRef}
                data={items}
                firstItemIndex={firstItemIndex}
                alignToBottom
                heightEstimates={itemHeightEstimates}
                computeItemKey={(_index, item) => timelineEntranceIdentity(item)}
                followOutput={false}
                atBottomThreshold={TIMELINE_BOTTOM_TOLERANCE_PX}
                atBottomStateChange={handleBottomStateChange}
                itemsRendered={handleItemsRendered}
                startReached={() => loadEarlierHistory()}
                scrollerRef={setScroller}
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
