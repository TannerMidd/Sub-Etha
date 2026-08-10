"use client";

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    CornerUpLeft,
    FileText,
    FileUp,
    ImageIcon,
    LoaderCircle,
    Pencil,
    Send,
    SmilePlus,
    X,
} from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import { firstImageFile, insertAtSelection, normalizeMediaFile } from "@/lib/matrix/media";
import type { TimelineItem } from "@/lib/matrix/types";

const EmojiPickerPanel = lazy(() =>
    import("./EmojiPickerPanel").then((module) => ({ default: module.EmojiPickerPanel })),
);

function formatSize(size: number): string {
    if (size < 1024) {
        return `${size} B`;
    }

    if (size < 1024 * 1024) {
        return `${Math.round(size / 1024)} KB`;
    }

    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

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
    const [attachment, setAttachment] = useState<File | null>(null);
    const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
    const [emojiOpen, setEmojiOpen] = useState(false);
    const [sending, setSending] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<number | null>(null);
    const [cancelUpload, setCancelUpload] = useState<(() => void) | null>(null);
    const [error, setError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const textarea = useRef<HTMLTextAreaElement>(null);
    const emojiWrap = useRef<HTMLDivElement>(null);
    const typingTimer = useRef<number | null>(null);
    const attachmentPreviewRef = useRef<string | null>(null);
    const trimmedBody = body.trim();
    const unchangedEdit = Boolean(editing && trimmedBody === editing.body.trim());
    const canSend = Boolean(attachment || trimmedBody) && !unchangedEdit && !sending;

    const syncTextareaHeight = useCallback(() => {
        const input = textarea.current;

        if (!input) {
            return;
        }

        const scrollTop = input.scrollTop;
        const caretAtEnd =
            document.activeElement === input &&
            input.selectionStart === input.value.length &&
            input.selectionEnd === input.value.length;

        input.style.height = "auto";
        input.style.overflowY = "hidden";
        input.style.height = `${input.scrollHeight}px`;
        const overflowing = input.scrollHeight > input.clientHeight;

        input.style.overflowY = overflowing ? "auto" : "hidden";

        if (overflowing) {
            input.scrollTop = caretAtEnd ? input.scrollHeight : scrollTop;
        }
    }, []);

    useLayoutEffect(() => {
        syncTextareaHeight();
    }, [body, syncTextareaHeight]);

    useEffect(() => {
        window.addEventListener("resize", syncTextareaHeight);

        return () => window.removeEventListener("resize", syncTextareaHeight);
    }, [syncTextareaHeight]);

    useEffect(() => {
        if (!editing) {
            return;
        }

        const frame = window.requestAnimationFrame(() => {
            const input = textarea.current;

            if (!input) {
                return;
            }

            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        });

        return () => window.cancelAnimationFrame(frame);
    }, [editing]);

    useEffect(() => {
        if (editing) {
            return;
        }

        if (body) {
            localStorage.setItem(draftKey, body);
        } else {
            localStorage.removeItem(draftKey);
        }
    }, [body, draftKey, editing]);

    useEffect(
        () => () => {
            if (typingTimer.current) {
                window.clearTimeout(typingTimer.current);
            }

            if (attachmentPreviewRef.current) {
                URL.revokeObjectURL(attachmentPreviewRef.current);
            }

            void service.setTyping(false);
        },
        [service],
    );

    useEffect(() => {
        if (!emojiOpen) {
            return;
        }

        const dismiss = (event: PointerEvent) => {
            if (!emojiWrap.current?.contains(event.target as Node)) {
                setEmojiOpen(false);
            }
        };

        const escape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setEmojiOpen(false);
            }
        };

        document.addEventListener("pointerdown", dismiss);
        window.addEventListener("keydown", escape);

        return () => {
            document.removeEventListener("pointerdown", dismiss);
            window.removeEventListener("keydown", escape);
        };
    }, [emojiOpen]);

    const updateBody = (value: string) => {
        setBody(value);
        void service.setTyping(Boolean(value));

        if (typingTimer.current) {
            window.clearTimeout(typingTimer.current);
        }

        typingTimer.current = window.setTimeout(() => void service.setTyping(false), 4_000);
    };

    const clearAttachment = useCallback(() => {
        if (attachmentPreviewRef.current) {
            URL.revokeObjectURL(attachmentPreviewRef.current);
        }

        attachmentPreviewRef.current = null;
        setAttachmentPreview(null);
        setAttachment(null);

        if (fileInput.current) {
            fileInput.current.value = "";
        }
    }, []);

    const stageFile = useCallback(
        async (source: File) => {
            const file = await normalizeMediaFile(source);

            clearAttachment();
            setAttachment(file);

            if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
                const preview = URL.createObjectURL(file);

                attachmentPreviewRef.current = preview;
                setAttachmentPreview(preview);
            }

            setError(null);
        },
        [clearAttachment],
    );

    const send = async () => {
        if (!canSend) {
            return;
        }

        setSending(true);
        setError(null);

        try {
            if (attachment) {
                setUploadProgress(0);
                await service.sendFile(
                    attachment,
                    { caption: body, replyTo: replyingTo?.id },
                    setUploadProgress,
                    (cancel) => setCancelUpload(cancel ? () => cancel : null),
                );
                clearAttachment();
            } else {
                await service.sendText(body, { replyTo: replyingTo?.id, editEventId: editing?.id });
            }

            setBody("");
            localStorage.removeItem(draftKey);
            onClearContext();
            await service.setTyping(false);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Message could not be sent.");
        } finally {
            setSending(false);
            setUploadProgress(null);
            setCancelUpload(null);
        }
    };

    const insertEmoji = (emoji: string) => {
        const input = textarea.current;
        const start = input?.selectionStart ?? body.length;
        const end = input?.selectionEnd ?? start;
        const next = insertAtSelection(body, emoji, start, end);

        updateBody(next.value);
        setEmojiOpen(false);
        window.requestAnimationFrame(() => {
            input?.focus();
            input?.setSelectionRange(next.caret, next.caret);
        });
    };

    const acceptClipboardImage = (data: DataTransfer | null): boolean => {
        const file = firstImageFile(data);

        if (!file) {
            return false;
        }

        void stageFile(file);

        return true;
    };

    return (
        <div
            className="composer-wrap"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
                event.preventDefault();
                const file = event.dataTransfer.files[0];

                if (file) {
                    void stageFile(file);
                }
            }}
        >
            {replyingTo || editing ? (
                <div className="composer-context" aria-live="polite">
                    {editing ? <Pencil aria-hidden="true" /> : <CornerUpLeft aria-hidden="true" />}
                    <span>
                        <strong>
                            {editing ? "Editing message" : `Replying to ${replyingTo?.senderName}`}
                        </strong>
                        {editing ? editing.body : replyingTo?.body}
                    </span>
                    <button
                        type="button"
                        aria-label={editing ? "Cancel message edit" : "Cancel reply"}
                        onClick={onClearContext}
                    >
                        <X />
                    </button>
                </div>
            ) : null}

            {attachment ? (
                <div className="attachment-stage">
                    <div className="attachment-stage__preview">
                        {attachmentPreview && attachment.type.startsWith("image/") ? (
                            // eslint-disable-next-line @next/next/no-img-element -- Device-local staged attachment.
                            <img src={attachmentPreview} alt="Attachment preview" />
                        ) : attachmentPreview && attachment.type.startsWith("video/") ? (
                            <video src={attachmentPreview} muted />
                        ) : attachment.type.startsWith("image/") ? (
                            <ImageIcon />
                        ) : (
                            <FileText />
                        )}
                    </div>
                    <div className="attachment-stage__copy">
                        <strong>{attachment.name}</strong>
                        <span>
                            {attachment.type || "Unknown file type"} · {formatSize(attachment.size)}
                        </span>
                        <small>
                            {body.trim()
                                ? "The message below will be used as its caption."
                                : "Add an optional caption below."}
                        </small>
                    </div>
                    <button
                        type="button"
                        aria-label="Remove attachment"
                        title="Remove attachment"
                        onClick={clearAttachment}
                        disabled={sending}
                    >
                        <X />
                    </button>
                </div>
            ) : null}

            {uploadProgress !== null ? (
                <div className="upload-progress">
                    <span style={{ width: `${uploadProgress}%` }} />
                    <p>Sending attachment · {uploadProgress}%</p>
                    {cancelUpload ? (
                        <button type="button" onClick={cancelUpload} aria-label="Cancel upload">
                            <X />
                        </button>
                    ) : null}
                </div>
            ) : null}

            <div className="composer">
                <input
                    ref={fileInput}
                    type="file"
                    className="sr-only"
                    onChange={(event) =>
                        event.target.files?.[0] && void stageFile(event.target.files[0])
                    }
                />
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Attach a file"
                    title="Attach a file"
                    onClick={() => fileInput.current?.click()}
                    disabled={sending || Boolean(editing)}
                >
                    <FileUp />
                </button>
                <div className="emoji-control" ref={emojiWrap}>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Choose an emoji"
                        title="Choose an emoji"
                        aria-expanded={emojiOpen}
                        onClick={() => setEmojiOpen((open) => !open)}
                    >
                        <SmilePlus />
                    </button>
                    {emojiOpen ? (
                        <div className="emoji-popover emoji-popover--composer">
                            <Suspense
                                fallback={
                                    <div className="emoji-loading">
                                        <LoaderCircle className="spin" /> Indexing pictograms…
                                    </div>
                                }
                            >
                                <EmojiPickerPanel onSelect={insertEmoji} />
                            </Suspense>
                        </div>
                    ) : null}
                </div>
                <label className="sr-only" htmlFor="message-composer">
                    {attachment ? "Attachment caption" : "Message"}
                </label>
                <textarea
                    ref={textarea}
                    id="message-composer"
                    value={body}
                    onChange={(event) => updateBody(event.target.value)}
                    onPaste={(event) => {
                        if (acceptClipboardImage(event.clipboardData)) {
                            event.preventDefault();
                        }
                    }}
                    onBeforeInput={(event) => {
                        const native = event.nativeEvent as InputEvent;

                        if (
                            native.inputType === "insertFromPaste" &&
                            acceptClipboardImage(native.dataTransfer)
                        ) {
                            event.preventDefault();
                        }
                    }}
                    onKeyDown={(event) => {
                        if (event.key === "Escape" && (editing || replyingTo) && !sending) {
                            event.preventDefault();
                            onClearContext();

                            return;
                        }

                        if (
                            event.key === "Enter" &&
                            !event.shiftKey &&
                            !event.nativeEvent.isComposing
                        ) {
                            event.preventDefault();
                            void send();
                        }
                    }}
                    placeholder={
                        editing
                            ? "Revise this message…"
                            : attachment
                              ? "Add a caption…"
                              : "Transmit a message…"
                    }
                    rows={1}
                />
                <button
                    type="button"
                    className="send-button"
                    aria-label={
                        editing
                            ? "Save message edit"
                            : attachment
                              ? "Send attachment"
                              : "Send message"
                    }
                    title={editing ? "Save edit" : undefined}
                    onClick={() => void send()}
                    disabled={!canSend}
                >
                    {sending ? <LoaderCircle className="spin" /> : <Send />}
                </button>
            </div>
            {error ? (
                <p className="composer-error" role="alert">
                    {error}
                </p>
            ) : (
                <p className="composer-hint">
                    Enter to {editing ? "save" : "send"} · Shift + Enter for a new line
                    {editing || replyingTo
                        ? " · Esc to cancel"
                        : " · Paste or drop images and GIFs"}
                </p>
            )}
        </div>
    );
}
