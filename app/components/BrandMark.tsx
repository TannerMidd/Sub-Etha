import { RadioTower } from "lucide-react";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand-mark${compact ? " brand-mark--compact" : ""}`} aria-label="Sub-Etha">
      <span className="brand-mark__signal" aria-hidden="true"><RadioTower size={compact ? 17 : 21} strokeWidth={1.8} /></span>
      <span className="brand-mark__word">SUB—ETHA</span>
      {compact ? null : <span className="brand-mark__edition">FIELD EDITION · 01</span>}
    </div>
  );
}

export function Avatar({ name, src, size = "medium" }: { name: string; src?: string | null; size?: "small" | "medium" | "large" }) {
  const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
  return (
    <span className={`avatar avatar--${size}`} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- Matrix avatars are authenticated remote media. */}
      {src ? <img src={src} alt="" loading="lazy" /> : <span>{initials}</span>}
    </span>
  );
}
