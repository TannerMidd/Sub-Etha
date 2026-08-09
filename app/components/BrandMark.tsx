"use client";

import { useEffect, useState } from "react";
import { RadioTower } from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";
import { isMxcUri } from "@/lib/matrix/media";

export function BrandMark({ compact = false, edition }: { compact?: boolean; edition?: string }) {
  return (
    <div className={`brand-mark${compact ? " brand-mark--compact" : ""}`} aria-label="Sub-Etha">
      <span className="brand-mark__signal" aria-hidden="true"><RadioTower size={compact ? 17 : 21} strokeWidth={1.8} /></span>
      <span className="brand-mark__word">SUB—ETHA</span>
      {compact ? null : <span className="brand-mark__edition">{edition ?? "FIELD EDITION · 01"}</span>}
    </div>
  );
}

export function Avatar({
  name,
  mxcUrl,
  service,
  size = "medium",
}: {
  name: string;
  mxcUrl?: string | null;
  service?: MatrixService;
  size?: "small" | "medium" | "large";
}) {
  const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  const matrixUrl = isMxcUri(mxcUrl) ? mxcUrl : null;
  const [loaded, setLoaded] = useState<{ mxcUrl: string; src: string } | null>(null);
  const src = loaded && loaded.mxcUrl === matrixUrl ? loaded.src : null;

  useEffect(() => {
    let active = true;
    if (!matrixUrl || !service) return () => { active = false; };
    const pixels = size === "large" ? 148 : size === "small" ? 56 : 96;
    void service.getMediaAsset({ mxcUrl: matrixUrl }, {
      width: pixels,
      height: pixels,
      resizeMethod: "crop",
      cacheKey: `avatar:${matrixUrl}:${pixels}`,
      expectedKind: "image",
    })
      .then((asset) => { if (active) setLoaded({ mxcUrl: matrixUrl, src: asset.url }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [matrixUrl, service, size]);

  return (
    <span className={`avatar avatar--${size}`} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- Matrix avatars are authenticated remote media. */}
      {src ? <img src={src} alt="" loading="lazy" /> : <span>{initials}</span>}
    </span>
  );
}
