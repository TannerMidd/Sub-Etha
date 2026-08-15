"use client";

import type { CSSProperties, ReactNode } from "react";
import { classes } from "../styles/appStyles";

/*
 * One bar of a placeholder. Width is passed rather than styled because a
 * skeleton's proportions belong to the content it stands in for — a room name
 * runs longer than its timestamp — not to the surface drawing it.
 *
 * Drawn as `<i>` rather than `<span>`: the timeline hides `[role="status"] >
 * span` to keep live-region text off screen, and a bar is not that text.
 */
export function SkeletonBar({
    width,
    height = 11,
    style,
}: {
    width: string;
    height?: number;
    style?: CSSProperties;
}) {
    return <i className={classes("skeleton")} style={{ width, height, ...style }} />;
}

/*
 * The announcement wrapper. Bars carry no text, so they contribute nothing to
 * the accessible tree on their own; the group states once that its surface is
 * loading rather than leaving a reader to count rectangles.
 */
export function SkeletonGroup({
    label,
    className,
    children,
}: {
    label: string;
    className?: string;
    children: ReactNode;
}) {
    return (
        <div
            className={classes("skeleton-group", className)}
            data-ui="skeleton"
            role="status"
            aria-busy="true"
        >
            {/*
             * The live region announces its content, not its label, so the
             * wait is stated as text rather than as an `aria-label` that most
             * assistive technology would never read out.
             */}
            <span className={classes("sr-only")}>{label}</span>
            {children}
        </div>
    );
}
