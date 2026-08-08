"use client";

import { useEffect, useState } from "react";
import { RadioTower } from "lucide-react";
import type { MatrixService } from "@/lib/matrix/client";

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
  const directUrl = mxcUrl && !mxcUrl.startsWith("mxc://") ? mxcUrl : null;
  const [loaded, setLoaded] = useState<{ mxcUrl: string; src: string } | null>(null);
  const src = directUrl ?? (loaded && loaded.mxcUrl === mxcUrl ? loaded.src : null);

  useEffect(() => {
    let active = true;
    if (!mxcUrl || directUrl || !service) return () => { active = false; };
    const pixels = size === "large" ? 148 : size === "small" ? 56 : 96;
    void service.getMediaAsset({ mxcUrl }, { width: pixels, height: pixels, resizeMethod: "crop", cacheKey: `avatar:${mxcUrl}:${pixels}` })
      .then((asset) => { if (active) setLoaded({ mxcUrl, src: asset.url }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [directUrl, mxcUrl, service, size]);

  return (
    <span className={`avatar avatar--${size}`} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- Matrix avatars are authenticated remote media. */}
      {src ? <img src={src} alt="" loading="lazy" /> : <span>{initials}</span>}
    </span>
  );
}
