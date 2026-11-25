"use client";

import { useEffect, useState } from "react";
import { getQueue } from "@/lib/client/queue";
import type { PosConfig, TicketData } from "@/lib/sale-types";
import { buildTicketFromSale } from "@/lib/ticket";
import QRCode from "qrcode";
import TicketView, { dianQrUrl } from "./TicketView";

export const POSCONFIG_KEY = "fecp_posconfig_v1";

type Loaded = { data: TicketData; config: PosConfig; qr?: string | null };

export default function TicketPage({ saleId }: { saleId: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState("");

  // 1) Cargar: primero el servidor; si no responde o no la conoce, la cola local (venta hecha sin conexión)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sales/${saleId}`, { cache: "no-store" });
        if (res.ok) {
          const { ticket, config } = (await res.json()) as { ticket: TicketData; config: PosConfig };
          try {
            localStorage.setItem(POSCONFIG_KEY, JSON.stringify(config));
          } catch {}
          // El QR se genera ANTES de mostrar la tirilla, para que salga en la impresión
          let qr: string | null = null;
          if (ticket.status === "invoiced" && ticket.cufe) {
            qr = await QRCode.toDataURL(dianQrUrl(ticket.cufe), { margin: 0, width: 240, errorCorrectionLevel: "M" }).catch(() => null);
          }
          if (!cancelled) setLoaded({ data: ticket, config, qr });
          return;
        }
      } catch {}
      const q = getQueue().find((x) => x.sale.id === saleId);
      let config: PosConfig | null = null;
      try {
        config = JSON.parse(localStorage.getItem(POSCONFIG_KEY) ?? "null");
      } catch {}
      if (cancelled) return;
      if (q && config) setLoaded({ data: buildTicketFromSale(q.sale, q.cashierName, q.warehouseName, config.creditoPlazoDias), config });
      else setError("No se encontró la venta.");
    })();
    return () => {
      cancelled = true;
    };
  }, [saleId]);

  // 2) Imprimir al cargar y cerrar al terminar (en iframe avisa a la caja para quitarlo)
  useEffect(() => {
    if (!loaded) return;
    const done = () => {
      if (window.parent !== window) window.parent.postMessage({ type: "ticket-printed", id: saleId }, location.origin);
      else window.close();
    };
    window.addEventListener("afterprint", done, { once: true });
    // Se imprime cuando el logo y el QR ya cargaron (máximo 2 s de espera: sin logo se imprime igual)
    let cancelled = false;
    const started = Date.now();
    const tick = () => {
      if (cancelled) return;
      const pending = [...document.images].some((i) => !i.complete);
      if (!pending || Date.now() - started > 2000) window.print();
      else setTimeout(tick, 100);
    };
    const t = setTimeout(tick, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
      window.removeEventListener("afterprint", done);
    };
  }, [loaded, saleId]);

  if (error) return <p style={{ padding: 16, fontFamily: "monospace" }}>{error}</p>;
  if (!loaded) return <p style={{ padding: 16, fontFamily: "monospace" }}>Cargando tirilla…</p>;
  return <TicketView data={loaded.data} config={loaded.config} qrDataUrl={loaded.qr} />;
}
