"use client";

import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";

function readDocumentNonce(): string | undefined {
    if (typeof document === "undefined") {
        return undefined;
    }

    return document.querySelector<HTMLScriptElement | HTMLStyleElement>(
        "script[nonce], style[nonce]",
    )?.nonce;
}

export function EmojiPickerPanel({
    onSelect,
    compact = false,
}: {
    onSelect: (emoji: string) => void;
    compact?: boolean;
}) {
    const nonce = readDocumentNonce();

    return (
        <EmojiPicker
            nonce={nonce}
            emojiStyle={EmojiStyle.NATIVE}
            theme={Theme.AUTO}
            lazyLoadEmojis
            searchPlaceholder="Search the galactic pictogram index"
            previewConfig={{ showPreview: false }}
            width="100%"
            height={compact ? 330 : 390}
            onEmojiClick={(data: EmojiClickData) => onSelect(data.emoji)}
        />
    );
}
