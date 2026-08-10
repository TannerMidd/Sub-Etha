export type TimelineChangeKind = "initial" | "append" | "prepend" | "items-change" | "replace";

export interface TimelineIdentity {
    id: string;
    own?: boolean;
}

export interface TimelineChange {
    kind: TimelineChangeKind;
    appendedOwnItem: boolean;
}

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
        return { kind: "initial", appendedOwnItem: next.some((item) => item.own) };
    }

    if (next.length === 0) {
        return { kind: "replace", appendedOwnItem: false };
    }

    const firstPreviousId = previous[0].id;
    const previousOffset = next.findIndex((item) => item.id === firstPreviousId);
    const prependedCount = previousFirstItemIndex - nextFirstItemIndex;

    if (
        prependedCount > 0 &&
        previousOffset === prependedCount &&
        sameIdsAtOffset(previous, next, previousOffset)
    ) {
        return { kind: "prepend", appendedOwnItem: false };
    }

    if (sameIdsAtOffset(previous, next, 0)) {
        const appended = next.slice(previous.length);

        if (appended.length > 0) {
            return { kind: "append", appendedOwnItem: appended.some((item) => item.own) };
        }

        return { kind: "items-change", appendedOwnItem: false };
    }

    return { kind: "replace", appendedOwnItem: next.some((item) => item.own) };
}

export function shouldScrollTimelineToBottom(
    change: TimelineChange,
    attachedToBottom: boolean,
): boolean {
    if (change.kind === "prepend") {
        return false;
    }

    if (change.kind === "append" && change.appendedOwnItem) {
        return true;
    }

    if (change.kind === "initial" || change.kind === "replace") {
        return true;
    }

    return attachedToBottom;
}

export function timelineAttachmentAfterBottomStateChange(
    attachedToBottom: boolean,
    reachedBottom: boolean,
): boolean {
    return reachedBottom ? true : attachedToBottom;
}
