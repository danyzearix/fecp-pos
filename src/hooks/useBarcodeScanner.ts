"use client";

import { useEffect, useRef } from "react";

const MAX_GAP_MS = 50; // las pistolas escriben más rápido que esto; una persona no
const MIN_LENGTH = 4;

/**
 * Escucha el teclado en toda la ventana. Junta caracteres que llegan con < 50 ms entre sí
 * y, al recibir Enter con 4+ caracteres, llama onScan(código).
 * Se ignora cuando el foco está en un campo de texto (cliente, pago, buscador):
 * el buscador maneja su propio Enter.
 */
export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const cb = useRef(onScan);
  useEffect(() => {
    cb.current = onScan;
  });

  useEffect(() => {
    if (!enabled) return;
    let buffer = "";
    let last = 0;

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) {
        buffer = "";
        return;
      }
      // Teclado EN PANTALLA de tablets/celulares y teclados con predicción: mandan eventos "compuestos"
      // o sin tecla real (keyCode 229). No son una pistola: se ignoran para no tragarse el Enter del usuario.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      if (e.key === "Enter") {
        if (buffer.length >= MIN_LENGTH) {
          e.preventDefault(); // evita que Enter active un botón enfocado
          const code = buffer;
          buffer = "";
          cb.current(code);
        } else {
          buffer = "";
        }
        return;
      }

      if (e.key.length !== 1) return; // Shift, Tab, flechas, etc.
      if (e.timeStamp - last > MAX_GAP_MS) buffer = ""; // pausa larga = otro tecleo, empezar de nuevo
      buffer += e.key;
      last = e.timeStamp;
    };

    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
