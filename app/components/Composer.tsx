"use client";

import { useEffect, useRef, useState } from "react";
import { CornerUpLeft, FileUp, LoaderCircle, Pencil, Send, X } from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import type { TimelineItem } from "@/lib/matrix/types";

export function Composer({
  roomId,
  service,
  replyingTo,
  editing,
  onClearContext,
}: {
  roomId: string;
  service: MatrixService;
  replyingTo: TimelineItem | null;
  editing: TimelineItem | null;
  onClearContext: () => void;
}) {
  const draftKey = `sub-etha-draft:${roomId}`;
  const [body, setBody] = useState(() => editing?.body ?? localStorage.getItem(draftKey) ?? "");
  const [sending, setSending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [cancelUpload, setCancelUpload] = useState<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const typingTimer = useRef<number | null>(null);

  useEffect(() => {
    if (editing) return;
    if (body) localStorage.setItem(draftKey, body);
    else localStorage.removeItem(draftKey);
  }, [body, draftKey, editing]);

  useEffect(() => () => {
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    void service.setTyping(false);
  }, [service]);

  const updateBody = (value: string) => {
    setBody(value);
    void service.setTyping(Boolean(value));
    if (typingTimer.current) window.clearTimeout(typingTimer.current);
    typingTimer.current = window.setTimeout(() => void service.setTyping(false), 4_000);
  };

  const send = async () => {
    if (!body.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await service.sendText(body, { replyTo: replyingTo?.id, editEventId: editing?.id });
      setBody("");
      localStorage.removeItem(draftKey);
      onClearContext();
      await service.setTyping(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Message could not be sent.");
    } finally {
      setSending(false);
    }
  };

  const upload = async (files: FileList | File[]) => {
    const file = files[0];
    if (!file) return;
    setUploadProgress(0);
    setError(null);
    try {
      await service.sendFile(file, setUploadProgress, (cancel) => setCancelUpload(cancel ? () => cancel : null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Attachment could not be sent.");
    } finally {
      setUploadProgress(null);
      setCancelUpload(null);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div
      className="composer-wrap"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files); }}
    >
      {replyingTo || editing ? (
        <div className="composer-context">
          {editing ? <Pencil aria-hidden="true" /> : <CornerUpLeft aria-hidden="true" />}
          <span><strong>{editing ? "Editing message" : `Replying to ${replyingTo?.senderName}`}</strong>{editing ? editing.body : replyingTo?.body}</span>
          <button type="button" aria-label="Cancel reply or edit" onClick={onClearContext}><X /></button>
        </div>
      ) : null}
      {uploadProgress !== null ? <div className="upload-progress"><span style={{ width: `${uploadProgress}%` }} /><p>Sending attachment · {uploadProgress}%</p>{cancelUpload ? <button type="button" onClick={cancelUpload} aria-label="Cancel upload"><X /></button> : null}</div> : null}
      <div className="composer">
        <input ref={fileInput} type="file" className="sr-only" onChange={(event) => event.target.files && void upload(event.target.files)} />
        <button type="button" className="icon-button" aria-label="Attach a file" title="Attach a file" onClick={() => fileInput.current?.click()} disabled={uploadProgress !== null}>
          <FileUp />
        </button>
        <label className="sr-only" htmlFor="message-composer">Message</label>
        <textarea
          id="message-composer"
          value={body}
          onChange={(event) => updateBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Transmit a message…"
          rows={1}
        />
        <button type="button" className="send-button" aria-label="Send message" onClick={() => void send()} disabled={!body.trim() || sending}>
          {sending ? <LoaderCircle className="spin" /> : <Send />}
        </button>
      </div>
      {error ? <p className="composer-error" role="alert">{error}</p> : <p className="composer-hint">Enter to send · Shift + Enter for a new line · Drop files anywhere here</p>}
    </div>
  );
}
