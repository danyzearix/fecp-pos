"use client";

import { useState } from "react";

/**
 * Logo de FECP. Archivo: public/logo.png (se sirve como /logo.png).
 * Mientras el archivo no exista, se muestra un recuadro "LOGO" del mismo tamaño.
 */
export const LOGO_SRC = "/logo.webp";

export default function Logo({ className = "", alt = "FECP" }: { className?: string; alt?: string }) {
  const [missing, setMissing] = useState(false);

  // Si la imagen falló ANTES de que React asignara onError (página renderizada en el servidor), el evento se pierde:
  // se revisa al montar si la imagen ya terminó de cargar sin ancho.
  const check = (img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth === 0) setMissing(true);
  };

  if (missing) {
    return (
      <div
        className={`flex items-center justify-center border-2 border-dashed border-field rounded-md text-[11px] font-semibold text-dim ${className}`}
        title="Coloca el logo en public/logo.png"
      >
        LOGO
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img ref={check} src={LOGO_SRC} alt={alt} onError={() => setMissing(true)} className={`object-contain ${className}`} />
  );
}
