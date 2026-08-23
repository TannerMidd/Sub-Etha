"use client";

import { Fragment, useEffect, useMemo, useRef } from "react";
import { messageTextSegments } from "@/lib/matrix/message-text";
import type { TimelineItem } from "@/lib/matrix/types";
import { classes } from "../../styles/appStyles";

export function PlainMessageBody({ body }: { body: string }) {
    const paragraphs = useMemo(
        () => body.split(/\n{2,}/).map((paragraph) => messageTextSegments(paragraph)),
        [body],
    );

    return (
        <div className={classes("message-body")}>
            {paragraphs.map((segments, paragraphIndex) => (
                <p key={paragraphIndex}>
                    {segments.map((segment, segmentIndex) =>
                        segment.href ? (
                            <a
                                key={`${segment.href}-${segmentIndex}`}
                                href={segment.href}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                {segment.text}
                            </a>
                        ) : (
                            <Fragment key={segmentIndex}>{segment.text}</Fragment>
                        ),
                    )}
                </p>
            ))}
        </div>
    );
}

/*
 * The only Trusted Types sink in the timeline. The HTML arrives pre-sanitized
 * by lib/matrix/trusted-html.ts; this component's effect hardens the rendered
 * tree afterwards (link targets, mx-color styles, spoiler disclosure).
 */
export function FormattedMessageBody({
    html,
}: {
    html: NonNullable<TimelineItem["formattedBody"]>;
}) {
    const bodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const root = bodyRef.current;

        if (!root) {
            return;
        }

        const cleanups: Array<() => void> = [];

        for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
        }

        for (const element of root.querySelectorAll<HTMLElement>(
            "[data-mx-color], [data-mx-bg-color]",
        )) {
            const foreground = element.dataset.mxColor;
            const background = element.dataset.mxBgColor;

            if (foreground && /^#[0-9a-f]{6}$/i.test(foreground)) {
                element.style.color = foreground;
            }

            if (background && /^#[0-9a-f]{6}$/i.test(background)) {
                element.style.backgroundColor = background;
            }
        }

        for (const spoiler of root.querySelectorAll<HTMLElement>("[data-mx-spoiler]")) {
            const reason = spoiler.dataset.mxSpoiler;

            spoiler.tabIndex = 0;
            spoiler.setAttribute("role", "button");
            spoiler.setAttribute("aria-expanded", "false");
            spoiler.setAttribute(
                "aria-label",
                reason ? `Spoiler: ${reason}. Activate to reveal.` : "Spoiler. Activate to reveal.",
            );

            const toggle = () => {
                const revealed = spoiler.toggleAttribute("data-revealed");

                spoiler.setAttribute("aria-expanded", String(revealed));
                spoiler.setAttribute(
                    "aria-label",
                    revealed
                        ? `Revealed spoiler${reason ? ` (${reason})` : ""}: ${spoiler.textContent ?? ""}`
                        : reason
                          ? `Spoiler: ${reason}. Activate to reveal.`
                          : "Spoiler. Activate to reveal.",
                );
            };

            const click = (event: MouseEvent) => {
                event.preventDefault();
                toggle();
            };

            const keydown = (event: KeyboardEvent) => {
                if (event.key !== "Enter" && event.key !== " ") {
                    return;
                }

                event.preventDefault();
                toggle();
            };

            spoiler.addEventListener("click", click);
            spoiler.addEventListener("keydown", keydown);
            cleanups.push(() => {
                spoiler.removeEventListener("click", click);
                spoiler.removeEventListener("keydown", keydown);
            });
        }

        return () => cleanups.forEach((cleanup) => cleanup());
    }, [html]);

    return (
        <div
            ref={bodyRef}
            className={classes("formatted-body")}
            dangerouslySetInnerHTML={{ __html: html }}
        />
    );
}
