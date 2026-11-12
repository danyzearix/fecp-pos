"use client";

import { useLayoutEffect, useState } from "react";
import { applyTheme, readTheme, type Theme } from "@/lib/client/theme";

const IconSun = ({ className = "" }: { className?: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className={className}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);
const IconMoon = ({ className = "" }: { className?: string }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
  </svg>
);

/**
 * Botón de modo oscuro. `variant`:
 *  - "sidebar": columna con ícono + texto (barra lateral de caja/historial)
 *  - "inline": fila compacta con ícono + texto (encabezado de administración)
 *  - "icon": solo el ícono (login)
 * El kiosco NO lleva botón: hereda el tema que dejó el administrador en ese equipo.
 */
export default function ThemeToggle({ variant = "sidebar", className = "" }: { variant?: "sidebar" | "inline" | "icon"; className?: string }) {
  const [theme, setTheme] = useState<Theme>("light");

  // Lee la preferencia y la reaplica. Dos motivos (los explica la guía de Next "preventing-flash-before-hydration"):
  //  1) El servidor no conoce localStorage: si el estado inicial se leyera al pintar, React avisaría de una
  //     diferencia con el HTML del servidor. Por eso arranca en "claro" y se corrige aquí, ANTES de pintar.
  //  2) En desarrollo React remonta una vez (Strict Mode) y borra los atributos de <html>, perdiendo la clase
  //     que puso el script del layout. Esto la devuelve. En producción es un no-op.
  useLayoutEffect(() => {
    const t = readTheme();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- corrección antes del pintado, no un ciclo de render
    setTheme(t);
    document.documentElement.classList.toggle("dark", t === "dark");
  }, []);

  const dark = theme === "dark";
  const label = dark ? "Modo claro" : "Modo oscuro";
  const toggle = () => {
    const next: Theme = dark ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  const common = "text-soft hover:bg-hover";
  const shape =
    variant === "sidebar"
      ? `flex flex-col items-center gap-1 py-3 text-xs font-medium w-full ${common}`
      : variant === "inline"
        ? `inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[14px] font-medium ${common}`
        : `inline-flex items-center justify-center w-11 h-11 rounded-lg ${common}`;

  return (
    <button onClick={toggle} className={`${shape} ${className}`} title={label} aria-label={label} aria-pressed={dark}>
      {dark ? <IconSun /> : <IconMoon />}
      {variant !== "icon" && label}
    </button>
  );
}
