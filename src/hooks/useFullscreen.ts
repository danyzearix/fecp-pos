"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Pantalla completa (API Fullscreen del navegador).
 * OJO: una página NO puede entrar en pantalla completa sola; el navegador exige un gesto del usuario
 * (un clic o un toque). Por eso siempre se activa desde un botón o desde el aviso "Toque para iniciar".
 * Para que el punto de venta abra ya en pantalla completa, se usan los accesos directos de Chrome (ver README).
 *
 * El estado se lee del propio navegador (useSyncExternalStore): si el usuario sale con Esc o F11,
 * el botón se entera igual.
 */
const subscribeFullscreen = (cb: () => void) => {
  document.addEventListener("fullscreenchange", cb);
  return () => document.removeEventListener("fullscreenchange", cb);
};
const noSubscribe = () => () => {};

export function useFullscreen() {
  const isFull = useSyncExternalStore(
    subscribeFullscreen,
    () => !!document.fullscreenElement,
    () => false // en el servidor nunca hay pantalla completa
  );
  const supported = useSyncExternalStore(
    noSubscribe,
    () => !!document.documentElement.requestFullscreen,
    () => true // en el servidor se asume que sí, para que el botón se pinte igual y no haya salto
  );

  /** Debe llamarse DENTRO del manejador de un clic/toque, o el navegador lo rechaza. */
  const toggle = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* el navegador puede negarlo (sin gesto del usuario, o bloqueado por política) */
    }
  }, []);

  return { isFull, supported, toggle };
}
