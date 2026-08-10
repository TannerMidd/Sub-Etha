export interface ComposerTextareaSize {
    height: number;
    overflowing: boolean;
}

export function resolveComposerTextareaSize(
    scrollHeight: number,
    minimumHeight: number,
    maximumHeight: number,
    borderHeight = 0,
): ComposerTextareaSize {
    const naturalHeight = Math.max(0, scrollHeight) + Math.max(0, borderHeight);
    const lowerBound = Math.max(0, minimumHeight);
    const upperBound = Math.max(lowerBound, maximumHeight);

    return {
        height: Math.min(upperBound, Math.max(lowerBound, naturalHeight)),
        overflowing: naturalHeight > upperBound + 0.5,
    };
}
