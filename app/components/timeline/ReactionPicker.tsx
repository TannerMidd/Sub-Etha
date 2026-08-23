"use client";

import { lazy, Suspense, useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import type { TimelineItem } from "@/lib/matrix/types";
import { classes } from "../../styles/appStyles";

const EmojiPickerPanel = lazy(() =>
    import("../EmojiPickerPanel").then((module) => ({ default: module.EmojiPickerPanel })),
);
const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

export function ReactionPicker({
    item,
    service,
    onClose,
}: {
    item: TimelineItem;
    service: MatrixService;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const dismiss = (event: PointerEvent) => {
            if (!ref.current?.contains(event.target as Node)) {
                onClose();
            }
        };

        const escape = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                onClose();
            }
        };

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
        <div
            ref={ref}
            className={classes("reaction-picker")}
            data-swipe-lock
            role="dialog"
            aria-label={`React to message from ${item.senderName}`}
        >
            <div className={classes("quick-reactions")}>
                {QUICK_REACTIONS.map((emoji) => (
                    <button type="button" key={emoji} onClick={() => choose(emoji)}>
                        {emoji}
                    </button>
                ))}
            </div>
            <Suspense
                fallback={
                    <div className={classes("emoji-loading")}>
                        <LoaderCircle className={classes("spin")} /> Indexing pictograms…
                    </div>
                }
            >
                <EmojiPickerPanel onSelect={choose} compact />
            </Suspense>
        </div>
    );
}
