"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { SkeletonBar, SkeletonGroup } from "../Skeleton";
import { classes } from "../../styles/appStyles";
import { DayDivider } from "./DayDivider";

export interface TimelineVirtuosoContext {
    loadingHistory: boolean;
    hasMoreHistory: boolean;
    firstTimestamp: number | null;
    requestEarlierHistory: () => void;
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

export const TIMELINE_COMPONENTS = {
    Header: TimelineHistoryHeader,
    Footer: TimelineFooter,
};
