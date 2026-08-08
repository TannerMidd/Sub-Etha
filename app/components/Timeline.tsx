"use client";

import { useEffect, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { CheckCheck, CornerUpLeft, Download, FileText, LoaderCircle, Pencil, RefreshCw, ShieldAlert, ThumbsUp, Trash2 } from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import type { TimelineItem } from "@/lib/matrix/types";
import { Avatar } from "./BrandMark";

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(timestamp);
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(timestamp);
}

function formatSize(size?: number): string {
  if (!size) return "File";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function MediaAttachment({ item, service }: { item: TimelineItem; service: MatrixService }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void service.getMediaUrl(item).then((value) => { if (active) setUrl(value); }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Media could not be loaded.");
    });
    return () => { active = false; };
  }, [item, service]);

  if (error) return <div className="media-error"><ShieldAlert aria-hidden="true" /><span>{error}</span></div>;
  if (!url) return <div className="media-loading"><LoaderCircle className="spin" aria-hidden="true" /> Decrypting attachment…</div>;
  if (item.type === "image") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="image-attachment">
        {/* eslint-disable-next-line @next/next/no-img-element -- Decrypted blob URL. */}
        <img src={url} alt={item.body} loading="lazy" />
      </a>
    );
  }
  if (item.type === "video") {
    // Matrix attachments do not include a caption track URL.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <video className="video-attachment" src={url} controls preload="metadata" />;
  }
  if (item.type === "audio") {
    // Matrix attachments do not include a caption track URL.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio className="audio-attachment" src={url} controls preload="metadata" />;
  }
  return (
    <a href={url} download={item.body} className="file-attachment">
      <span><FileText aria-hidden="true" /></span>
      <span><strong>{item.body}</strong><small>{formatSize(item.media?.size)}</small></span>
      <Download aria-hidden="true" />
    </a>
  );
}

function DayDivider({ timestamp }: { timestamp: number }) {
  return <div className="day-divider" role="separator"><span>{formatDate(timestamp)}</span></div>;
}

function MessageRow({
  item,
  previous,
  service,
  onReply,
  onEdit,
}: {
  item: TimelineItem;
  previous?: TimelineItem;
  service: MatrixService;
  onReply: (item: TimelineItem) => void;
  onEdit: (item: TimelineItem) => void;
}) {
  const newDay = !previous || new Date(previous.timestamp).toDateString() !== new Date(item.timestamp).toDateString();
  if (item.type === "system") {
    return <>{newDay ? <DayDivider timestamp={item.timestamp} /> : null}<div className="system-event"><span>{item.body}</span><time>{formatTime(item.timestamp)}</time></div></>;
  }
  return (
    <>
      {newDay ? <DayDivider timestamp={item.timestamp} /> : null}
      <article className={`message-row${item.own ? " message-row--own" : ""}${item.type === "notice" ? " message-row--notice" : ""}`} data-event-id={item.id}>
        <Avatar name={item.senderName} src={item.senderAvatarUrl} />
        <div className="message-row__main">
          <header>
            <strong>{item.senderName}</strong>
            <time dateTime={new Date(item.timestamp).toISOString()}>{formatTime(item.timestamp)}</time>
            {item.edited ? <span className="edited-label">edited</span> : null}
            {item.encrypted ? <span className="encrypted-label" title="Encrypted message">E2E</span> : null}
          </header>
          {item.replyTo ? <div className="reply-context"><CornerUpLeft aria-hidden="true" />Reply to an earlier transmission</div> : null}
          {item.redacted ? <p className="redacted-body">Message removed</p> : item.formattedBody ? (
            <div className="formatted-body" dangerouslySetInnerHTML={{ __html: item.formattedBody }} />
          ) : item.type === "file" ? null : <p className="message-body">{item.body}</p>}
          {item.media ? <MediaAttachment item={item} service={service} /> : null}
          {item.reactions.length ? (
            <div className="reaction-list" aria-label="Reactions">
              {item.reactions.map((reaction) => (
                <button key={reaction.key} type="button" className={reaction.mine ? "is-mine" : ""} onClick={() => void service.react(item.id, reaction.key)}>
                  <span>{reaction.key}</span><span>{reaction.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          {item.sendingStatus ? (
            <div className={`send-status send-status--${item.sendingStatus}`}>
              <span>{item.sendingStatus === "not_sent" ? "Could not send" : "Sending…"}</span>
              {item.sendingStatus === "not_sent" ? <button type="button" onClick={() => void service.retry(item)}><RefreshCw aria-hidden="true" />Retry</button> : null}
            </div>
          ) : null}
          {item.readBy.length ? <div className="read-receipt"><CheckCheck aria-hidden="true" />Read by {item.readBy.join(", ")}</div> : null}
        </div>
        {!item.redacted && item.sendingStatus !== "not_sent" ? (
          <div className="message-actions" aria-label={`Actions for message from ${item.senderName}`}>
            <button type="button" title="Reply" aria-label="Reply" onClick={() => onReply(item)}><CornerUpLeft /></button>
            <button type="button" title="React with thumbs up" aria-label="React with thumbs up" onClick={() => void service.react(item.id, "👍")}><ThumbsUp /></button>
            {item.own ? <button type="button" title="Edit" aria-label="Edit" onClick={() => onEdit(item)}><Pencil /></button> : null}
            {item.own ? <button type="button" title="Remove" aria-label="Remove" onClick={() => void service.redact(item.id)}><Trash2 /></button> : null}
          </div>
        ) : null}
      </article>
    </>
  );
}

export function Timeline({
  items,
  service,
  loadingHistory,
  unreadCount,
  onReply,
  onEdit,
}: {
  items: TimelineItem[];
  service: MatrixService;
  loadingHistory: boolean;
  unreadCount: number;
  onReply: (item: TimelineItem) => void;
  onEdit: (item: TimelineItem) => void;
}) {
  if (!items.length) {
    return (
      <div className="timeline-empty">
        <div className="empty-orbit" aria-hidden="true"><span /></div>
        <p className="eyebrow">NO SIGNALS RECORDED</p>
        <h3>This room contains mostly space.</h3>
        <p>You could leave it pristine, but history suggests someone will type eventually.</p>
      </div>
    );
  }

  return (
    <div className="timeline" aria-label="Room messages">
      <Virtuoso
        data={items}
        initialTopMostItemIndex={Math.max(0, items.length - 1)}
        followOutput={(atBottom) => atBottom ? "smooth" : false}
        increaseViewportBy={{ top: 600, bottom: 300 }}
        components={{
          Header: () => (
            <div className="history-loader">
              <button type="button" onClick={() => void service.paginate()} disabled={loadingHistory}>
                {loadingHistory ? <LoaderCircle className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                {loadingHistory ? "Consulting earlier pages…" : "Load earlier messages"}
              </button>
            </div>
          ),
        }}
        itemContent={(index, item) => (
          <>
            {unreadCount > 0 && index === Math.max(0, items.length - unreadCount) ? <div className="unread-divider" role="separator"><span>New messages</span></div> : null}
            <MessageRow item={item} previous={items[index - 1]} service={service} onReply={onReply} onEdit={onEdit} />
          </>
        )}
      />
    </div>
  );
}
