export const INITIAL_TIMELINE_ITEM_INDEX = 1_000_000;

export function countPrependedTimelineItems(
    previousFirstItemId: string | null,
    nextItemIds: readonly string[],
): number {
    if (!previousFirstItemId) {
        return 0;
    }

    const previousItemIndex = nextItemIds.indexOf(previousFirstItemId);

    return Math.max(0, previousItemIndex);
}

export function timelineStartIndexAfterPrepend(
    currentStartIndex: number,
    previousFirstItemId: string | null,
    nextItemIds: readonly string[],
): number {
    const prependedCount = countPrependedTimelineItems(previousFirstItemId, nextItemIds);

    return Math.max(0, currentStartIndex - prependedCount);
}
