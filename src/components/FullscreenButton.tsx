"use client";

import { useFullscreen } from "@/hooks/useFullscreen";

const IconExpand = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);
const IconShrink = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 8h3a2 2 0 0 0 2-2V3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M21 16h-3a2 2 0 0 0-2 2v3" />
  </svg>
);

/** Botón de pantalla completa. Muestra su estado (expandir / salir). */
export default function FullscreenButton({ variant = "sidebar", className = "" }: { variant?: "sidebar" | "inline" | "icon"; className?: string }) {
  const { isFull, supported, toggle } = useFullscreen();
  if (!supported) return null;

  const label = isFull ? "Salir de pantalla completa" : "Pantalla completa";
  const common = "text-soft hover:bg-hover";
  const shape =
    variant === "sidebar"
      ? `flex flex-col items-center gap-1 py-3 min-h-11 text-xs font-medium w-full ${common}`
      : variant === "inline"
        ? `inline-flex items-center gap-2 rounded-lg px-3 min-h-11 text-[14px] font-medium ${common}`
        : `inline-flex items-center justify-center w-11 h-11 rounded-lg ${common}`;

  return (
    <button onClick={() => void toggle()} className={`${shape} ${className}`} title={label} aria-label={label} aria-pressed={isFull}>
      {isFull ? <IconShrink /> : <IconExpand />}
      {variant === "sidebar" && (isFull ? "Salir" : "Pantalla")}
      {variant === "inline" && label}
    </button>
  );
}
