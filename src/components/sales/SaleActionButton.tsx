"use client";

import { useState } from "react";

/**
 * Botón de reintento (solo admin; el endpoint también lo exige).
 *  - 'failed' / 'pending' → "Reintentar" (vuelve a facturar).
 *  - 'revisar' → "Verificar en Siigo" (busca el UUID en observations; NUNCA reintenta a ciegas).
 */
export default function SaleActionButton({ saleId, status, onDone }: { saleId: string; status: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  if (!["failed", "pending", "pagado", "revisar"].includes(status)) return null;
  const verify = status === "revisar";

  async function run() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/sales/${saleId}/retry`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setMsg(d.error ?? `Error ${res.status}`);
      else setMsg(d.status === "invoiced" ? `Facturada ${d.invoice_name ?? ""}` : d.error ?? `Estado: ${d.status}`);
      onDone();
    } catch {
      setMsg("Sin conexión con el servidor");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        onClick={run}
        disabled={busy}
        className="px-3 min-h-11 rounded-md border border-brand text-brand-text text-[13px] font-medium hover:bg-brand-soft disabled:opacity-50"
      >
        {busy ? "Procesando…" : verify ? "Verificar en Siigo" : "Reintentar"}
      </button>
      {msg && <span className="text-[12px] text-soft max-w-[220px]">{msg}</span>}
    </span>
  );
}
