"use client";

import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import {
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CornerUpLeft,
  Download,
  FileText,
  LoaderCircle,
  Maximize2,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  Scan,
  ShieldAlert,
  SmilePlus,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import { messageTextSegments } from "@/lib/matrix/message-text";
import type { MediaAsset, TimelineItem } from "@/lib/matrix/types";
import { Avatar } from "./BrandMark";

const EmojiPickerPanel = lazy(() => import("./EmojiPickerPanel").then((module) => ({ default: module.EmojiPickerPanel })));
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

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

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function useTimelineMedia(item: TimelineItem, service: MatrixService, retryToken = 0) {
  const requestKey = `${item.id}:${retryToken}`;
  const [result, setResult] = useState<{ key: string; asset: MediaAsset | null; error: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    if (!item.media) return () => { active = false; };
    void service.getMediaAsset(item.media, { cacheKey: item.id }).then((value) => {
      if (active) setResult({ key: requestKey, asset: value, error: null });
    }).catch((cause) => {
      if (active) setResult({ key: requestKey, asset: null, error: cause instanceof Error ? cause.message : "Media could not be loaded." });
    });
    return () => { active = false; };
  }, [item.id, item.media, requestKey, service]);
  return result?.key === requestKey ? result : { asset: null, error: null };
}

function AnimatedImage({ item, service, asset, className, onOpen }: {
  item: TimelineItem;
  service: MatrixService;
  asset: MediaAsset;
  className?: string;
  onOpen?: (opener: HTMLElement) => void;
}) {
  const reducedMotion = useReducedMotion();
  const [playOverride, setPlayOverride] = useState(false);
  const [poster, setPoster] = useState<string | null>(null);
  const playing = !reducedMotion || playOverride;

  useEffect(() => {
    let active = true;
    if (!asset.animated || !reducedMotion || !item.media) return () => { active = false; };
    void service.getGifPoster(item.media, item.id).then((url) => { if (active) setPoster(url); });
    return () => { active = false; };
  }, [asset.animated, item.id, item.media, reducedMotion, service]);

  return (
    <span
      className={`animated-image${className ? ` ${className}` : ""}`}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `View ${item.body || "image"}` : undefined}
      onClick={onOpen ? (event) => onOpen(event.currentTarget) : undefined}
      onKeyDown={onOpen ? (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(event.currentTarget);
        }
      } : undefined}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Decrypted Matrix object URL. */}
      <img
        src={!asset.animated || playing ? asset.url : poster ?? undefined}
        alt={item.body || `Image from ${item.senderName}`}
        width={item.media?.width}
        height={item.media?.height}
        loading="lazy"
      />
      {asset.animated && !playing ? (
        <button type="button" className="gif-play" onClick={(event) => { event.stopPropagation(); setPlayOverride(true); }}><Play />Play GIF</button>
      ) : null}
    </span>
  );
}

function MediaAttachment({ item, service, onOpen }: { item: TimelineItem; service: MatrixService; onOpen: (item: TimelineItem, opener: HTMLElement) => void }) {
  const [retryToken, setRetryToken] = useState(0);
  const { asset, error } = useTimelineMedia(item, service, retryToken);

  const retry = () => {
    if (item.media) service.invalidateMedia(item.media, item.id);
    setRetryToken((value) => value + 1);
  };

  if (error) return <div className="media-error"><ShieldAlert aria-hidden="true" /><span>{error}</span><button type="button" onClick={retry}><RefreshCw />Retry</button></div>;
  if (!asset) return <div className="media-loading"><LoaderCircle className="spin" aria-hidden="true" /> Decrypting attachment…</div>;
  if (item.type === "image") {
    return (
      <div className="image-attachment">
        <AnimatedImage item={item} service={service} asset={asset} onOpen={(opener) => onOpen(item, opener)} />
        <span className="image-attachment__hint" aria-hidden="true"><Maximize2 />View</span>
      </div>
    );
  }
  if (item.type === "video") {
    // Matrix attachments do not include a caption track URL.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <video className="video-attachment" src={asset.url} controls preload="metadata" />;
  }
  if (item.type === "audio") {
    // Matrix attachments do not include a caption track URL.
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio className="audio-attachment" src={asset.url} controls preload="metadata" />;
  }
  return (
    <a href={asset.url} download={item.body} className="file-attachment">
      <span><FileText aria-hidden="true" /></span>
      <span><strong>{item.body}</strong><small>{formatSize(item.media?.size)}</small></span>
      <Download aria-hidden="true" />
    </a>
  );
}

function ReactionPicker({ item, service, onClose }: { item: TimelineItem; service: MatrixService; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [onClose]);

  const choose = (emoji: string) => {
    void service.toggleReaction(item.id, emoji);
    onClose();
  };

  return (
    <div ref={ref} className="reaction-picker" role="dialog" aria-label={`React to message from ${item.senderName}`}>
      <div className="quick-reactions">
        {QUICK_REACTIONS.map((emoji) => <button type="button" key={emoji} onClick={() => choose(emoji)}>{emoji}</button>)}
      </div>
      <Suspense fallback={<div className="emoji-loading"><LoaderCircle className="spin" /> Indexing pictograms…</div>}>
        <EmojiPickerPanel onSelect={choose} compact />
      </Suspense>
    </div>
  );
}

function Lightbox({ items, selectedId, service, onSelect, onClose }: {
  items: TimelineItem[];
  selectedId: string;
  service: MatrixService;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const index = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const item = items[index];
  const [zoom, setZoom] = useState<number | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const { asset, error } = useTimelineMedia(item, service, retryToken);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  const move = (direction: number) => {
    if (items.length < 2) return;
    onSelect(items[(index + direction + items.length) % items.length].id);
    setZoom(null);
  };

  useEffect(() => {
    closeButton.current?.focus();
  }, []);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && items.length > 1) {
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        onSelect(items[(index + direction + items.length) % items.length].id);
        setZoom(null);
      }
      else if (event.key === "Tab") {
        const focusable = panel.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]");
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [index, items, onClose, onSelect]);

  if (!item) return null;
  return (
    <div className="lightbox" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panel} className="lightbox__panel" role="dialog" aria-modal="true" aria-label={`Viewing ${item.body || "image"}`}>
        <header className="lightbox__header">
          <div><strong>{item.body || "Image"}</strong><span>{item.senderName} · {formatTime(item.timestamp)}</span></div>
          <div className="lightbox__tools">
            <button type="button" onClick={() => setZoom(null)} aria-label="Fit image to screen" title="Fit to screen"><Maximize2 /></button>
            <button type="button" onClick={() => setZoom(1)} aria-label="Show image at actual size" title="Actual size"><Scan /></button>
            <button type="button" onClick={() => setZoom((value) => Math.max(0.25, (value ?? 1) - 0.25))} aria-label="Zoom out"><ZoomOut /></button>
            <button type="button" onClick={() => setZoom((value) => Math.min(4, (value ?? 1) + 0.25))} aria-label="Zoom in"><ZoomIn /></button>
            {asset ? <a href={asset.url} download={item.body || "matrix-image"} aria-label="Download image" title="Download"><Download /></a> : null}
            <button ref={closeButton} type="button" onClick={onClose} aria-label="Close image viewer"><X /></button>
          </div>
        </header>
        <div className={`lightbox__stage${zoom === null ? " is-fit" : ""}`}>
          {error ? <div className="lightbox__error"><ShieldAlert /><strong>Image unavailable</strong><span>{error}</span><button type="button" onClick={() => { if (item.media) service.invalidateMedia(item.media, item.id); setRetryToken((value) => value + 1); }}><RefreshCw />Retry</button></div> : null}
          {!asset && !error ? <div className="lightbox__loading"><LoaderCircle className="spin" />Decrypting the full transmission…</div> : null}
          {asset ? <div style={zoom === null ? undefined : { transform: `scale(${zoom})` }}><AnimatedImage item={item} service={service} asset={asset} className="lightbox__image" /></div> : null}
        </div>
        {items.length > 1 ? (
          <>
            <button type="button" className="lightbox__previous" onClick={() => move(-1)} aria-label="Previous image"><ChevronLeft /></button>
            <button type="button" className="lightbox__next" onClick={() => move(1)} aria-label="Next image"><ChevronRight /></button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function DayDivider({ timestamp }: { timestamp: number }) {
  return <div className="day-divider" role="separator"><span>{formatDate(timestamp)}</span></div>;
}

function PlainMessageBody({ body }: { body: string }) {
  const segments = useMemo(() => messageTextSegments(body), [body]);
  return (
    <p className="message-body">
      {segments.map((segment, index) => segment.href ? (
        <a key={`${segment.href}-${index}`} href={segment.href} target="_blank" rel="noopener noreferrer">{segment.text}</a>
      ) : <Fragment key={index}>{segment.text}</Fragment>)}
    </p>
  );
}

function FormattedMessageBody({ html }: { html: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    const cleanups: Array<() => void> = [];
    for (const link of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    for (const element of root.querySelectorAll<HTMLElement>("[data-mx-color], [data-mx-bg-color]")) {
      const foreground = element.dataset.mxColor;
      const background = element.dataset.mxBgColor;
      if (foreground && /^#[0-9a-f]{6}$/i.test(foreground)) element.style.color = foreground;
      if (background && /^#[0-9a-f]{6}$/i.test(background)) element.style.backgroundColor = background;
    }
    for (const spoiler of root.querySelectorAll<HTMLElement>("[data-mx-spoiler]")) {
      const reason = spoiler.dataset.mxSpoiler;
      spoiler.tabIndex = 0;
      spoiler.setAttribute("role", "button");
      spoiler.setAttribute("aria-expanded", "false");
      spoiler.setAttribute("aria-label", reason ? `Spoiler: ${reason}. Activate to reveal.` : "Spoiler. Activate to reveal.");
      const toggle = () => {
        const revealed = spoiler.toggleAttribute("data-revealed");
        spoiler.setAttribute("aria-expanded", String(revealed));
        spoiler.setAttribute("aria-label", revealed
          ? `Revealed spoiler${reason ? ` (${reason})` : ""}: ${spoiler.textContent ?? ""}`
          : reason ? `Spoiler: ${reason}. Activate to reveal.` : "Spoiler. Activate to reveal.");
      };
      const click = (event: MouseEvent) => {
        event.preventDefault();
        toggle();
      };
      const keydown = (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
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
      className="formatted-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function MessageRow({ item, previous, service, onReply, onEdit, onOpenMedia }: {
  item: TimelineItem;
  previous?: TimelineItem;
  service: MatrixService;
  onReply: (item: TimelineItem) => void;
  onEdit: (item: TimelineItem) => void;
  onOpenMedia: (item: TimelineItem, opener: HTMLElement) => void;
}) {
  const [reactionOpen, setReactionOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const rowRef = useRef<HTMLElement>(null);
  const newDay = !previous || new Date(previous.timestamp).toDateString() !== new Date(item.timestamp).toDateString();
  const editable = item.own && item.type === "message" && !item.media && !item.sendingStatus;

  useEffect(() => {
    if (!actionsOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!rowRef.current?.contains(event.target as Node)) {
        setActionsOpen(false);
        setReactionOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActionsOpen(false);
        setReactionOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [actionsOpen]);

  if (item.type === "system") {
    return <>{newDay ? <DayDivider timestamp={item.timestamp} /> : null}<div className="system-event"><span>{item.body}</span><time>{formatTime(item.timestamp)}</time></div></>;
  }
  return (
    <>
      {newDay ? <DayDivider timestamp={item.timestamp} /> : null}
      <article ref={rowRef} className={`message-row${item.own ? " message-row--own" : ""}${item.type === "notice" ? " message-row--notice" : ""}${actionsOpen ? " is-actions-open" : ""}`} data-event-id={item.id} aria-label={`Message from ${item.senderName}`}>
        <Avatar name={item.senderName} mxcUrl={item.senderAvatarMxcUrl} service={service} />
        <div className="message-row__main">
          <header>
            <strong>{item.senderName}</strong>
            <time dateTime={new Date(item.timestamp).toISOString()}>{formatTime(item.timestamp)}</time>
            {item.edited ? <span className="edited-label">edited</span> : null}
            {item.encrypted ? <span className="encrypted-label" title="Encrypted message">E2E</span> : null}
          </header>
          {item.replyTo ? <div className="reply-context"><CornerUpLeft aria-hidden="true" />Reply to an earlier transmission</div> : null}
          {item.redacted ? <p className="redacted-body">Message removed</p> : item.formattedBody ? (
            <FormattedMessageBody html={item.formattedBody} />
          ) : item.type === "file" ? null : <PlainMessageBody body={item.body} />}
          {item.media ? <MediaAttachment item={item} service={service} onOpen={onOpenMedia} /> : null}
          {item.reactions.length ? (
            <div className="reaction-list" aria-label="Reactions">
              {item.reactions.map((reaction) => (
                <button key={reaction.key} type="button" className={reaction.mine ? "is-mine" : ""} aria-pressed={reaction.mine} onClick={() => void service.toggleReaction(item.id, reaction.key)}>
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
        {!item.redacted && !item.sendingStatus ? (
          <button type="button" className="message-actions-toggle" aria-label={`Show actions for message from ${item.senderName}`} aria-expanded={actionsOpen} onClick={() => setActionsOpen((open) => !open)}><MoreHorizontal /></button>
        ) : null}
        {!item.redacted && !item.sendingStatus ? (
          <div className="message-actions" aria-label={`Actions for message from ${item.senderName}`}>
            <button type="button" title="Reply" aria-label="Reply" onClick={() => { setActionsOpen(false); onReply(item); }}><CornerUpLeft /></button>
            <button type="button" title="Add reaction" aria-label="Add reaction" aria-expanded={reactionOpen} onClick={() => setReactionOpen((open) => !open)}><SmilePlus /></button>
            {editable ? <button type="button" title="Edit" aria-label="Edit" onClick={() => { setActionsOpen(false); onEdit(item); }}><Pencil /></button> : null}
            {item.own ? <button type="button" title="Remove" aria-label="Remove" onClick={() => { setActionsOpen(false); void service.redact(item.id); }}><Trash2 /></button> : null}
            {reactionOpen ? <ReactionPicker item={item} service={service} onClose={() => setReactionOpen(false)} /> : null}
          </div>
        ) : null}
      </article>
    </>
  );
}

export function Timeline({ items, service, loadingHistory, unreadCount, onReply, onEdit }: {
  items: TimelineItem[];
  service: MatrixService;
  loadingHistory: boolean;
  unreadCount: number;
  onReply: (item: TimelineItem) => void;
  onEdit: (item: TimelineItem) => void;
}) {
  const [lightboxId, setLightboxId] = useState<string | null>(null);
  const lightboxOpener = useRef<HTMLElement | null>(null);
  const imageItems = useMemo(() => items.filter((item) => item.type === "image" && item.media && !item.redacted), [items]);
  const closeLightbox = () => {
    setLightboxId(null);
    window.requestAnimationFrame(() => lightboxOpener.current?.focus());
  };

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
            <MessageRow
              item={item}
              previous={items[index - 1]}
              service={service}
              onReply={onReply}
              onEdit={onEdit}
              onOpenMedia={(mediaItem, opener) => { lightboxOpener.current = opener; setLightboxId(mediaItem.id); }}
            />
          </>
        )}
      />
      {lightboxId && imageItems.length ? <Lightbox items={imageItems} selectedId={lightboxId} service={service} onSelect={setLightboxId} onClose={closeLightbox} /> : null}
    </div>
  );
}
