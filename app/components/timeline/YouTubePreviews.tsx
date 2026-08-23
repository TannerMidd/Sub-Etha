"use client";

import { useState } from "react";
import { youtubeThumbnailFailureStore, type YouTubePreview } from "@/lib/youtube-preview";
import { classes } from "../../styles/appStyles";

function YouTubePreviewCard({ preview }: { preview: YouTubePreview }) {
    const [failed, setFailed] = useState(() => youtubeThumbnailFailureStore.has(preview.id));

    const markFailed = () => {
        youtubeThumbnailFailureStore.markFailed(preview.id);
        setFailed(true);
    };

    const contents = (
        <>
            <span className={classes("youtube-preview__media")} aria-hidden="true">
                {failed ? null : (
                    // YouTube must receive the browser-direct public thumbnail URL.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={preview.src}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={markFailed}
                    />
                )}
            </span>
            <span className={classes("youtube-preview__metadata")}>
                {failed ? "YouTube preview unavailable" : "Watch on YouTube"}
            </span>
        </>
    );

    return failed ? (
        <div className={classes("youtube-preview")} aria-label="YouTube preview unavailable">
            {contents}
        </div>
    ) : (
        <a
            className={classes("youtube-preview")}
            href={preview.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Watch video on YouTube"
        >
            {contents}
        </a>
    );
}

export function YouTubePreviewCards({ previews }: { previews: YouTubePreview[] }) {
    if (!previews.length) {
        return null;
    }

    return (
        <div className={classes("youtube-preview-list")} aria-label="YouTube previews">
            {previews.map((preview) => (
                <YouTubePreviewCard key={preview.id} preview={preview} />
            ))}
        </div>
    );
}
