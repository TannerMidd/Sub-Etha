"use client";

import { classes } from "../../styles/appStyles";

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

export function DayDivider({ timestamp }: { timestamp: number }) {
    return (
        <div className={classes("day-divider")} role="separator">
            <time dateTime={new Date(timestamp).toISOString()} title={formatFullDate(timestamp)}>
                {formatDate(timestamp)}
            </time>
        </div>
    );
}
