"use client";

// Comprobantes en el historial (/ventas): botón/ícono por venta, visor grande con descarga y "Adjuntar comprobante".
// Las imágenes se piden a /api/sales/<id>/comprobante (autenticado, sin caché); cada vista y descarga queda en logs.
import { useState } from "react";
import ReceiptCapture from "@/components/ReceiptCapture";
import { uploadReceipt } from "@/lib/client/receipts";
import { paymentLabel, paymentShortLabel } from "@/lib/payments";
import { receiptAllowed, receiptRequired } from "@/lib/receipt-rules";
import type { SaleListRow } from "@/lib/sales";

const fmtDate = (iso: string) => new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "medium", timeStyle: "short" });
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("es-CO", { timeZone: "America/Bogota", dateStyle: "long" });

/** Transferencia sin foto (pendiente o de antes de exigirla): se resalta en el historial. */
// El comprobante depende de los medios de las LÍNEAS de pago: transferencia = obligatorio; tarjeta = opcional.
const methodsOf = (s: SaleListRow) => s.payments.map((p) => p.method);
export const missingRequiredReceipt = (s: SaleListRow) => receiptRequired(methodsOf(s)) && s.receipt_status !== "activo" && s.receipt_status !== "eliminado";

const IconReceipt = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <circle cx="9" cy="11" r="2" />
    <path d="m21 16-5-5-8 8" />
  </svg>
);

/** Celda/acción de comprobante de una venta en el historial. */
export function ReceiptCell({ s, isAdmin, onChanged }: { s: SaleListRow; isAdmin: boolean; onChanged: () => void }) {
  const [view, setView] = useState(false);
  const [attach, setAttach] = useState(false);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function upload(b: Blob) {
    setAttach(false);
    setBusy(true);
    setMsg("");
    const r = await uploadReceipt(s.id, b);
    setBusy(false);
    if (r.kind === "ok") {
      setMsg("");
      onChanged();
    } else setMsg(r.kind === "rejected" ? r.error : r.kind === "missing" ? "La venta aún no llega al servidor." : "Sin conexión: intente de nuevo.");
  }

  const has = s.receipt_status === "activo" || s.receipt_status === "eliminado";
  return (
    <div className="flex flex-col items-start gap-1">
      {has ? (
        <button
          onClick={() => setView(true)}
          className={`inline-flex items-center gap-1.5 px-3 min-h-11 rounded-md border text-[13px] font-semibold ${
            s.receipt_status === "activo" ? "border-brand text-brand-text hover:bg-brand-soft" : "border-field text-dim"
          }`}
          title={s.receipt_status === "activo" ? "Ver comprobante" : "Comprobante eliminado por retención"}
        >
          <IconReceipt /> {s.receipt_status === "activo" ? "Ver comprobante" : "Eliminado"}
        </button>
      ) : receiptAllowed(methodsOf(s)) ? (
        <>
          {s.receipt_status === "pendiente" && <span className="px-2 py-0.5 rounded-full text-[12px] font-semibold bg-warn-soft text-warn-ink">Comprobante pendiente</span>}
          <button
            onClick={() => setAttach(true)}
            disabled={busy}
            className="px-3 min-h-11 rounded-md border border-field text-[13px] font-medium text-body hover:bg-hover disabled:opacity-50"
          >
            {busy ? "Subiendo…" : "Adjuntar comprobante"}
          </button>
        </>
      ) : (
        <span className="text-[12px] text-dim">—</span>
      )}
      {msg && <span className="text-[12px] text-err-ink max-w-[220px]">{msg}</span>}

      {view && <ReceiptViewer s={s} isAdmin={isAdmin} onClose={() => setView(false)} onReplace={() => { setView(false); setAttach(true); }} />}
      {attach && <ReceiptCapture title={`Comprobante de ${s.local_number}`} onCancel={() => setAttach(false)} onAccept={(b) => void upload(b)} />}
    </div>
  );
}

function ReceiptViewer({ s, isAdmin, onClose, onReplace }: { s: SaleListRow; isAdmin: boolean; onClose: () => void; onReplace: () => void }) {
  const [imgError, setImgError] = useState(false);
  const src = `/api/sales/${s.id}/comprobante`;
  const deleted = s.receipt_status === "eliminado";
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="Comprobante de pago" onClick={onClose}>
      <div className="bg-surface text-fg w-full h-full sm:h-auto sm:max-h-[95vh] sm:max-w-[900px] sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 sm:px-6 py-3 border-b border-line flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-bold">Comprobante · {s.invoice_name ?? s.local_number}</h2>
            <p className="text-[13px] text-dim truncate">{s.local_number} · {s.customer_name}</p>
          </div>
          <button onClick={onClose} className="px-3 min-h-11 rounded-lg border border-field text-[14px] text-body shrink-0">Cerrar</button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 grid gap-4 md:grid-cols-[1fr_240px]">
          <div className="rounded-xl bg-black/90 grid place-items-center min-h-[240px]">
            {deleted ? (
              <p className="p-6 text-center text-white text-[15px]">
                Eliminado por retención el {s.receipt_deleted_at ? fmtDay(s.receipt_deleted_at) : "—"}.
              </p>
            ) : imgError ? (
              <p className="p-6 text-center text-white text-[14px]">No se pudo cargar la imagen.</p>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={`Comprobante de ${s.local_number}`} className="max-h-[70vh] w-auto object-contain" onError={() => setImgError(true)} />
            )}
          </div>

          <dl className="text-[14px] space-y-2">
            <div><dt className="text-dim text-[12px]">Fecha de la foto</dt><dd>{s.receipt_uploaded_at ? fmtDate(s.receipt_uploaded_at) : "—"}</dd></div>
            <div><dt className="text-dim text-[12px]">Medio de pago</dt><dd>{s.payments.length > 1 ? s.payments.map((p) => `${paymentShortLabel(p.method)} ${Math.round(p.amount).toLocaleString("es-CO")}`).join(" + ") : paymentLabel(s.payment_method)}</dd></div>
            <div><dt className="text-dim text-[12px]">Referencia</dt><dd className="break-all">{s.payment_reference ?? "—"}</dd></div>
            <div><dt className="text-dim text-[12px]">Subido por</dt><dd>{s.receipt_uploaded_by ?? "—"}</dd></div>
            <div><dt className="text-dim text-[12px]">Fecha de la venta</dt><dd>{fmtDate(s.created_at)}</dd></div>
            <div className="pt-2 flex flex-col gap-2">
              {!deleted && !imgError && (
                <a href={`${src}?descargar=1`} className="inline-flex items-center justify-center px-4 min-h-11 rounded-lg bg-brand text-white text-[14px] font-semibold">
                  Descargar
                </a>
              )}
              {isAdmin && (
                <button onClick={onReplace} className="px-4 min-h-11 rounded-lg border border-field text-[13px] font-medium text-body">
                  {deleted ? "Adjuntar otro comprobante" : "Reemplazar (solo admin)"}
                </button>
              )}
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
