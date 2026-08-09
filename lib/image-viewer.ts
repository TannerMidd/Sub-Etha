export interface ViewerSize {
    width: number;
    height: number;
}

export const MIN_VIEWER_ZOOM = 1;
export const MAX_VIEWER_ZOOM = 4;
export const VIEWER_ZOOM_STEP = 0.25;

export function containImageSize(image: ViewerSize, viewport: ViewerSize): ViewerSize {
    if (image.width <= 0 || image.height <= 0 || viewport.width <= 0 || viewport.height <= 0) {
        return { width: 0, height: 0 };
    }

    const scale = Math.min(1, viewport.width / image.width, viewport.height / image.height);
    return {
        width: image.width * scale,
        height: image.height * scale,
    };
}

export function clampViewerZoom(zoom: number): number {
    return Math.min(MAX_VIEWER_ZOOM, Math.max(MIN_VIEWER_ZOOM, zoom));
}

export function stepViewerZoom(zoom: number, direction: -1 | 1): number {
    return clampViewerZoom(zoom + (VIEWER_ZOOM_STEP * direction));
}

export function preserveScrollCenter(
    scrollOffset: number,
    viewportLength: number,
    previousContentLength: number,
    nextContentLength: number,
): number {
    if (viewportLength <= 0 || previousContentLength <= 0 || nextContentLength <= viewportLength) {
        return 0;
    }

    const previousCenter = previousContentLength <= viewportLength
        ? 0.5
        : (scrollOffset + (viewportLength / 2)) / previousContentLength;
    const nextOffset = (previousCenter * nextContentLength) - (viewportLength / 2);
    return Math.min(nextContentLength - viewportLength, Math.max(0, nextOffset));
}
