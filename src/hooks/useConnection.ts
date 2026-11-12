"use client";

import { useEffect, useState } from "react";
import { pendingCount } from "@/lib/client/queue";

/** Estado de conexión del navegador y ventas pendientes en la cola local (para la barra lateral). */
export function useConnection() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);
  useEffect(() => {
    const upd = () => setOnline(navigator.onLine);
    upd();
    setPending(pendingCount());
    window.addEventListener("online", upd);
    window.addEventListener("offline", upd);
    const iv = setInterval(() => setPending(pendingCount()), 2000);
    return () => {
      window.removeEventListener("online", upd);
      window.removeEventListener("offline", upd);
      clearInterval(iv);
    };
  }, []);
  return { online, pending };
}
