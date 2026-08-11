"use client";

import EmojiPicker, { EmojiStyle, Theme, type EmojiClickData } from "emoji-picker-react";

export function EmojiPickerPanel({
    onSelect,
    compact = false,
}: {
    onSelect: (emoji: string) => void;
    compact?: boolean;
}) {
    return (
        <EmojiPicker
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
