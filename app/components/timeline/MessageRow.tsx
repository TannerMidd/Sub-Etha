"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
    CheckCheck,
    CornerUpLeft,
    LoaderCircle,
    Pencil,
    RefreshCw,
    ShieldAlert,
    SmilePlus,
    Trash2,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import { timelineYouTubePreviews } from "@/lib/youtube-preview";
import type { TimelineItem } from "@/lib/matrix/types";
import { classes } from "../../styles/appStyles";
import { DayDivider } from "./DayDivider";
import { FormattedMessageBody, PlainMessageBody } from "./MessageBody";
import { MediaAttachment } from "./Media";
import { ReactionPicker } from "./ReactionPicker";
import { YouTubePreviewCards } from "./YouTubePreviews";
import { formatTime, getAuthorAccentStyle, REACTION_POP_MS, timelineItemHasActions } from "./utils";

function replyExcerpt(item: TimelineItem): string {
    const firstLine = item.body.split("\n", 1)[0] ?? item.body;

    return firstLine.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? firstLine;
}

export function MessageRow({
    item,
    next,
    replyItem,
    entering,
    service,
    onReply,
    onEdit,
    onOpenMedia,
}: {
    item: TimelineItem;
    next?: TimelineItem;
    replyItem?: TimelineItem;
    entering: boolean;
    service: MatrixService;
    onReply: (item: TimelineItem) => void;
    onEdit: (item: TimelineItem) => void;
    onOpenMedia: (item: TimelineItem, opener: HTMLElement) => void;
}) {
    const [reactionOpen, setReactionOpen] = useState(false);
    /*
     * Which reaction is mid-pop. Set on the click rather than on the round
     * trip, because the pop acknowledges the tap; whether the homeserver
     * accepts it is what the count itself reports a moment later.
     */
    const [poppedReaction, setPoppedReaction] = useState<string | null>(null);
    const popTimer = useRef<number | null>(null);
    const rowRef = useRef<HTMLElement>(null);

    useEffect(
        () => () => {
            if (popTimer.current !== null) {
                window.clearTimeout(popTimer.current);
            }
        },
        [],
    );
    const nextDay =
        next && new Date(next.timestamp).toDateString() !== new Date(item.timestamp).toDateString();
    const actionable = timelineItemHasActions(item);
    const editable = actionable && item.own && item.type === "message" && !item.media;
    const youtubePreviews = useMemo(() => timelineYouTubePreviews(item), [item]);

    if (item.type === "system") {
        return (
            <>
                <div className={classes("system-event")}>
                    <span>{item.body}</span>
                    <time>{formatTime(item.timestamp)}</time>
                </div>
                {nextDay ? <DayDivider timestamp={next.timestamp} /> : null}
            </>
        );
    }

    return (
        <>
            <article
                ref={rowRef}
                className={classes(
                    `message-row${item.own ? " message-row--own" : ""}${item.type === "notice" ? " message-row--notice" : ""}${next ? "" : " message-row--last"}`,
                )}
                style={getAuthorAccentStyle(item, replyItem)}
                data-ui="message-row"
                data-enter={entering ? "in" : undefined}
                data-send-state={item.sendingStatus ?? undefined}
                data-event-id={item.id}
                aria-label={`Message from ${item.senderName}`}
            >
                <time
                    className={classes("message-row__time")}
                    dateTime={new Date(item.timestamp).toISOString()}
                >
                    {formatTime(item.timestamp)}
                </time>
                <div className={classes("message-row__main")} data-ui="message-content">
                    <span className={classes("message-row__marker")} aria-hidden="true" />
                    <header>
                        <strong>{item.own ? "You" : item.senderName}</strong>
                        {item.edited ? (
                            <span className={classes("edited-label")}>edited</span>
                        ) : null}
                        {item.encrypted ? (
                            <span className={classes("encrypted-label")} title="Encrypted message">
                                E2E
                            </span>
                        ) : null}
                    </header>
                    {item.replyTo ? (
                        <div className={classes("reply-context")}>
                            <CornerUpLeft aria-hidden="true" />
                            {replyItem
                                ? `${replyItem.own ? "You" : replyItem.senderName} — ${replyExcerpt(replyItem)}`
                                : item.replySummary
                                  ? `${item.replySummary.senderName} — ${item.replySummary.body}`
                                  : "Reply to an earlier transmission"}
                        </div>
                    ) : null}
                    {item.redacted ? (
                        <p className={classes("redacted-body")}>Message removed</p>
                    ) : item.decryptionState === "decrypting" ? (
                        <div className={classes("decryption-state")} role="status">
                            <LoaderCircle className={classes("spin")} aria-hidden="true" />
                            <span>Decrypting transmission…</span>
                        </div>
                    ) : item.decryptionState === "failed" ? (
                        <div
                            className={classes("decryption-state decryption-state--failed")}
                            role="status"
                        >
                            <ShieldAlert aria-hidden="true" />
                            <span>
                                This transmission could not be decrypted on this device. Sub-Etha
                                will retry if the keys arrive.
                            </span>
                        </div>
                    ) : item.formattedBody ? (
                        <FormattedMessageBody html={item.formattedBody} />
                    ) : item.type === "file" ? null : (
                        <PlainMessageBody body={item.body} />
                    )}
                    <YouTubePreviewCards previews={youtubePreviews} />
                    {item.media ? (
                        <MediaAttachment item={item} service={service} onOpen={onOpenMedia} />
                    ) : null}
                    {item.reactions.length ? (
                        <div className={classes("reaction-list")} aria-label="Reactions">
                            {item.reactions.map((reaction) => (
                                <button
                                    key={reaction.key}
                                    type="button"
                                    className={classes(reaction.mine ? "is-mine" : "")}
                                    data-pop={reaction.key === poppedReaction ? "true" : undefined}
                                    aria-pressed={reaction.mine}
                                    onClick={() => {
                                        setPoppedReaction(reaction.key);

                                        if (popTimer.current !== null) {
                                            window.clearTimeout(popTimer.current);
                                        }

                                        popTimer.current = window.setTimeout(() => {
                                            popTimer.current = null;
                                            setPoppedReaction(null);
                                        }, REACTION_POP_MS);

                                        void service.toggleReaction(item.id, reaction.key);
                                    }}
                                >
                                    <span>{reaction.key}</span>
                                    <span>{reaction.count}</span>
                                </button>
                            ))}
                        </div>
                    ) : null}
                    {item.sendingStatus ? (
                        <div className={classes(`send-status send-status--${item.sendingStatus}`)}>
                            <span>
                                {item.sendingStatus === "not_sent" ? "Could not send" : "Sending…"}
                            </span>
                            {item.sendingStatus === "not_sent" ? (
                                <button type="button" onClick={() => void service.retry(item)}>
                                    <RefreshCw aria-hidden="true" />
                                    Retry
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                    {item.readBy.length ? (
                        <div className={classes("read-receipt")}>
                            <CheckCheck aria-hidden="true" />
                            Read by {item.readBy.join(", ")}
                        </div>
                    ) : null}
                </div>
                {actionable ? (
                    <div
                        className={classes("message-actions")}
                        data-ui="message-actions"
                        aria-label={`Actions for message from ${item.senderName}`}
                    >
                        <button
                            type="button"
                            title="Reply"
                            aria-label="Reply"
                            onClick={() => {
                                setReactionOpen(false);
                                onReply(item);
                            }}
                        >
                            <CornerUpLeft />
                        </button>
                        <button
                            type="button"
                            title="Add reaction"
                            aria-label="Add reaction"
                            aria-expanded={reactionOpen}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={() => {
                                setReactionOpen((open) => !open);
                            }}
                        >
                            <SmilePlus />
                        </button>
                        {editable ? (
                            <button
                                type="button"
                                title="Edit"
                                aria-label="Edit"
                                onClick={() => onEdit(item)}
                            >
                                <Pencil />
                            </button>
                        ) : null}
                        {item.own ? (
                            <button
                                type="button"
                                title="Remove"
                                aria-label="Remove"
                                onClick={() => void service.redact(item.id)}
                            >
                                <Trash2 />
                            </button>
                        ) : null}
                        {reactionOpen ? (
                            <ReactionPicker
                                item={item}
                                service={service}
                                onClose={() => setReactionOpen(false)}
                            />
                        ) : null}
                    </div>
                ) : null}
            </article>
            {nextDay ? <DayDivider timestamp={next.timestamp} /> : null}
        </>
    );
}
