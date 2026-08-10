export type MobileSwipeAction = "open-index" | "close-index" | null;

export interface MobileSwipeGesture {
    startX: number;
    endX: number;
    startY: number;
    endY: number;
    elapsedMs: number;
    viewportWidth: number;
    indexOpen: boolean;
}

const EDGE_START_PX = 32;
const MIN_DISTANCE_PX = 58;
const MIN_FLING_DISTANCE_PX = 34;
const MIN_FLING_VELOCITY_PX_MS = 0.45;
const HORIZONTAL_DOMINANCE = 1.35;

export function guideEntryCode(roomId: string): string {
    let hash = 2166136261;

    for (let index = 0; index < roomId.length; index += 1) {
        hash ^= roomId.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    const normalized = hash >>> 0;
    const entry = String((normalized % 89) + 1).padStart(2, "0");
    const sector = String.fromCharCode(65 + (Math.floor(normalized / 89) % 6));

    return `${entry}-${sector}`;
}

export function canStartMobileSwipe(startX: number, indexOpen: boolean): boolean {
    return indexOpen || startX <= EDGE_START_PX;
}

export function shouldDeferRoomHistorySeed(
    activeRoomId: string,
    routedRoomId: string | null,
    availableRoomIds: readonly string[],
): boolean {
    return Boolean(
        routedRoomId && routedRoomId !== activeRoomId && availableRoomIds.includes(routedRoomId),
    );
}

export function resolveMobileSwipe(gesture: MobileSwipeGesture): MobileSwipeAction {
    const deltaX = gesture.endX - gesture.startX;
    const deltaY = gesture.endY - gesture.startY;
    const distanceX = Math.abs(deltaX);
    const distanceY = Math.abs(deltaY);
    const elapsedMs = Math.max(gesture.elapsedMs, 1);
    const velocity = distanceX / elapsedMs;
    const viewportThreshold = Math.min(84, Math.max(MIN_DISTANCE_PX, gesture.viewportWidth * 0.18));
    const deliberate = distanceX >= viewportThreshold;
    const fling = distanceX >= MIN_FLING_DISTANCE_PX && velocity >= MIN_FLING_VELOCITY_PX_MS;

    if (distanceX < distanceY * HORIZONTAL_DOMINANCE || (!deliberate && !fling)) {
        return null;
    }

    if (!gesture.indexOpen && deltaX > 0) {
        return "open-index";
    }

    if (gesture.indexOpen && deltaX < 0) {
        return "close-index";
    }

    return null;
}
