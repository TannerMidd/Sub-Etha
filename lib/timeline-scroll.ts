export type TimelineChangeKind =
    "initial" | "append" | "prepend" | "items-change" | "window-shift" | "replace";

export interface TimelineIdentity {
    id: string;
    local?: boolean;
}

export interface TimelineChange {
    kind: TimelineChangeKind;
    appendedLocalItem: boolean;
}

export type TimelineScrollMode = "initializing" | "attached" | "detached" | "restoring-history";

export type TimelineScrollEvent =
    | { type: "room-change" }
    | { type: "initial-positioned" }
    | { type: "bottom-state"; atBottom: boolean }
    | { type: "user-detach" }
    | { type: "history-start" }
    | { type: "history-complete" }
    | { type: "local-append" };

function sameIdsAtOffset(
    previous: readonly TimelineIdentity[],
    next: readonly TimelineIdentity[],
    offset: number,
): boolean {
    if (offset < 0 || offset + previous.length > next.length) {
        return false;
    }

    for (let index = 0; index < previous.length; index += 1) {
        if (previous[index].id !== next[offset + index].id) {
            return false;
        }
    }

    return true;
}

export function classifyTimelineChange(
    previous: readonly TimelineIdentity[],
    next: readonly TimelineIdentity[],
    previousFirstItemIndex: number,
    nextFirstItemIndex: number,
): TimelineChange {
    if (previous.length === 0) {
        return { kind: "initial", appendedLocalItem: next.some((item) => item.local) };
    }

    if (next.length === 0) {
        return { kind: "replace", appendedLocalItem: false };
    }

    const firstPreviousId = previous[0].id;
    const previousOffset = next.findIndex((item) => item.id === firstPreviousId);
    const prependedCount = previousFirstItemIndex - nextFirstItemIndex;

    if (
        prependedCount > 0 &&
        previousOffset === prependedCount &&
        sameIdsAtOffset(previous, next, previousOffset)
    ) {
        return { kind: "prepend", appendedLocalItem: false };
    }

    if (sameIdsAtOffset(previous, next, 0)) {
        const appended = next.slice(previous.length);

        if (appended.length > 0) {
            return { kind: "append", appendedLocalItem: appended.some((item) => item.local) };
        }

        return { kind: "items-change", appendedLocalItem: false };
    }

    const previousIds = new Set(previous.map((item) => item.id));
    const retainedItem = next.some((item) => previousIds.has(item.id));

    if (retainedItem) {
        return {
            kind: "window-shift",
            appendedLocalItem: next.some((item) => !previousIds.has(item.id) && item.local),
        };
    }

    return { kind: "replace", appendedLocalItem: false };
}

export function shouldFollowTimelineChange(
    change: TimelineChange,
    mode: TimelineScrollMode,
): boolean {
    if (change.kind === "prepend") {
        return false;
    }

    if (change.appendedLocalItem) {
        return true;
    }

    if (change.kind === "initial") {
        return true;
    }

    if (change.kind === "items-change") {
        return false;
    }

    return mode === "attached";
}

export function transitionTimelineScrollMode(
    mode: TimelineScrollMode,
    event: TimelineScrollEvent,
): TimelineScrollMode {
    switch (event.type) {
        case "room-change":
            return "initializing";
        case "initial-positioned":
        case "local-append":
            return "attached";
        case "bottom-state":
            return event.atBottom ? "attached" : "detached";
        case "user-detach":
        case "history-complete":
            return "detached";
        case "history-start":
            return "restoring-history";
        default:
            return mode;
    }
}
