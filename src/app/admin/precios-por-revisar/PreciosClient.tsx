"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatCOP } from "@/lib/money";
import { paymentShortLabel } from "@/lib/payments";
import { ageLevel, heldText, REASON_LABEL, type ReviewDetail, type ReviewLine } from "@/lib/price-review-rules";

export type HeldRow = {
  id: string;
  local_number: string;
  total: number;
  cashier: string;
  sale_time: string;
  held_since: string;
  held_min: number;
  detail: ReviewDetail;
  time_note: string | null;
  methods: string[];
};
export type DecidedRow = {
  local_number: string;
  decision: "aprobada" | "anulada";
  by_name: string | null;
  decided_at: string | null;
  note: string | null;
  total: number;
  invoice_name: string | null;
  status: string;
};

const when = (iso: string) => new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" });
const taxText = (rate: number | null, incl: boolean | null) => (rate === null ? "—" : `${rate}% ${incl ? "incl." : "+ IVA"}`);
const money = (n: number | null) => (n === null ? "—" : formatCOP(n));
const signed = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatCOP(Math.abs(n))}`);

function Lines({ lines }: { lines: ReviewLine[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-[13px] text-fg">
        <thead className="bg-subtle text-left text-body">
          <tr>
            <th className="px-3 py-1.5">Producto</th>
            <th className="px-3 py-1.5 text-right">Cant.</th>
            <th className="px-3 py-1.5">Enviado por la caja</th>
            <th className="px-3 py-1.5">Vigente en la base</th>
            <th className="px-3 py-1.5 text-right">Diferencia</th>
            <th className="px-3 py-1.5">Motivo</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {lines.map((l, i) => {
            const bad = l.reasons.length > 0;
            return (
              <tr key={i} className={bad ? "bg-warn-soft" : ""}>
                <td className="px-3 py-1.5 max-w-[240px]">
                  <div className="font-medium break-words">{l.name}</div>
                  <div className="text-[12px] text-dim">SKU {l.sku_sent}</div>
                </td>
                <td className="px-3 py-1.5 text-right">{l.quantity}</td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  <div className={l.reasons.includes("precio") ? "font-bold text-err-ink" : ""}>{money(l.price_sent)}</div>
                  <div className={`text-[12px] ${l.reasons.includes("iva") ? "font-bold text-err-ink" : "text-dim"}`}>{taxText(l.tax_sent, l.incl_sent)}</div>
                </td>
                <td className="px-3 py-1.5 whitespace-nowrap">
                  {l.product_id === null || l.price_now === null ? (
                    <span className="text-dim">no existe en la base</span>
                  ) : (
                    <>
                      <div>{money(l.price_now)}</div>
                      <div className="text-[12px] text-dim">{taxText(l.tax_now, l.incl_now)}</div>
                      {l.reasons.includes("sku") && <div className="text-[12px] font-bold text-err-ink">SKU {l.sku_now ?? "(sin SKU)"}</div>}
                    </>
                  )}
                </td>
                <td className={`px-3 py-1.5 text-right whitespace-nowrap font-semibold ${(l.diff_line ?? 0) < 0 ? "text-err-ink" : ""}`}>
                  {signed(l.diff_line)}
                  {l.diff_unit !== null && l.quantity !== 1 && <div className="text-[11px] font-normal text-dim">{signed(l.diff_unit)} c/u</div>}
                </td>
                <td className="px-3 py-1.5 text-[12px]">{bad ? l.reasons.map((r) => REASON_LABEL[r]).join(" · ") : <span className="text-ok-ink">Coincide</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Card({ r, onDone }: { r: HeldRow; onDone: () => void }) {
  const [mode, setMode] = useState<"" | "aprobar" | "anular">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const level = ageLevel(r.held_min);

  async function run(kind: "aprobar" | "anular") {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/admin/precios/${r.id}/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note }) });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(d.error ?? `Error ${res.status}`);
        if (res.status === 409) onDone(); // ya la decidió otro admin: se refresca la lista
      } else {
        setMsg(kind === "anular" ? "Anulada" : d.status === "invoiced" ? `Facturada ${d.invoice_name ?? ""}` : `Aprobada. Estado de la factura: ${d.status}${d.error ? ` — ${d.error}` : ""}`);
        setMode("");
        onDone();
      }
    } catch {
      setMsg("Sin conexión con el servidor");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={`rounded-xl border bg-surface overflow-hidden ${level === "critica" ? "border-2 border-err-line" : level === "atrasada" ? "border-2 border-warn-line" : "border-line"}`}>
      <div className={`px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-1 ${level === "critica" ? "bg-err-soft" : level === "atrasada" ? "bg-warn-soft" : "bg-subtle"}`}>
        <div>
          <div className="text-[12px] text-dim">Venta</div>
          <div className="font-bold">{r.local_number}</div>
        </div>
        <div>
          <div className="text-[12px] text-dim">Cajero</div>
          <div>{r.cashier}</div>
        </div>
        <div>
          <div className="text-[12px] text-dim">Hora de la venta</div>
          <div>{when(r.sale_time)}</div>
        </div>
        <div>
          <div className="text-[12px] text-dim">Cobrado (total de la venta)</div>
          <div className="font-bold">{formatCOP(r.total)}</div>
          <div className="text-[12px] text-dim">{r.methods.map((m) => paymentShortLabel(m)).join(" + ")}</div>
        </div>
        <div>
          <div className="text-[12px] text-dim">Retenida desde {when(r.held_since)}</div>
          <div className={`font-bold ${level === "critica" ? "text-err-ink" : level === "atrasada" ? "text-warn-ink" : ""}`}>
            Lleva {heldText(r.held_min)}
            {level === "critica" && <span className="ml-2 px-2 py-0.5 rounded-full text-[11px] bg-err text-white">MUY ATRASADA (+4 h)</span>}
            {level === "atrasada" && <span className="ml-2 px-2 py-0.5 rounded-full text-[11px] bg-warn-soft text-warn-ink border border-warn-line">ATRASADA (+2 h)</span>}
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-[12px] text-dim">Diferencia total (enviado − vigente)</div>
          <div className="font-bold text-lg">{signed(r.detail.diff_total)}</div>
        </div>
      </div>

      <Lines lines={r.detail.lines} />
      {r.time_note && <p className="px-4 py-2 text-[12px] text-dim">⏱ {r.time_note}</p>}

      <div className="px-4 py-3 border-t border-line space-y-2">
        {mode === "" && (
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setMode("aprobar")} className="px-4 min-h-11 rounded-lg bg-brand text-white text-[14px] font-semibold">Aprobar y facturar</button>
            <button onClick={() => setMode("anular")} className="px-4 min-h-11 rounded-lg border border-err-line text-err-ink text-[14px] font-semibold hover:bg-err-soft">Anular</button>
            <span className="text-[12px] text-dim">No hay “corregir al precio de la base”: el cliente ya pagó el monto original y los pagos no cuadrarían.</span>
          </div>
        )}
        {mode === "aprobar" && (
          <div className="space-y-2 max-w-xl">
            <p className="text-[13px] text-body">
              ¿Confirma? La venta se factura <b>con los precios enviados por la caja</b> ({formatCOP(r.total)}). Úselo solo si el cambio es legítimo (por ejemplo, una promoción).
            </p>
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Nota (opcional), p. ej. «promoción del fin de semana»" className="w-full border border-field rounded-lg px-3 min-h-11 text-[14px] bg-surface text-fg" />
            <div className="flex gap-2">
              <button onClick={() => run("aprobar")} disabled={busy} className="px-4 min-h-11 rounded-lg bg-brand text-white text-[14px] font-semibold disabled:opacity-50">{busy ? "Facturando…" : "Sí, aprobar y facturar"}</button>
              <button onClick={() => setMode("")} disabled={busy} className="px-4 min-h-11 rounded-lg border border-field text-[14px] text-body">No</button>
            </div>
          </div>
        )}
        {mode === "anular" && (
          <div className="space-y-2 max-w-xl">
            <p className="text-[13px] text-body">
              La venta <b>no se facturará nunca</b>. El dinero ya se cobró: saldrá en el cuadre y en los reportes como <b>“Ventas anuladas con dinero cobrado”</b>. Escribe el motivo.
            </p>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} placeholder="Motivo de la anulación (obligatorio, mínimo 5 caracteres)" className="w-full border border-field rounded-lg px-3 py-2 text-[14px] bg-surface text-fg" />
            <div className="flex gap-2">
              <button onClick={() => run("anular")} disabled={busy || note.trim().length < 5} className="px-4 min-h-11 rounded-lg bg-err text-white text-[14px] font-semibold disabled:opacity-50">{busy ? "Anulando…" : "Sí, anular"}</button>
              <button onClick={() => setMode("")} disabled={busy} className="px-4 min-h-11 rounded-lg border border-field text-[14px] text-body">No</button>
            </div>
          </div>
        )}
        {msg && <p className="text-[13px] text-soft">{msg}</p>}
      </div>
    </section>
  );
}

export default function PreciosClient({ held, decided, windowHours }: { held: HeldRow[]; decided: DecidedRow[]; windowHours: number }) {
  const router = useRouter();
  const refresh = () => router.refresh();
  const total = held.reduce((a, r) => a + r.total, 0);
  return (
    <div className="space-y-6 max-w-6xl min-w-0 text-fg">
      <div>
        <h1 className="text-2xl font-bold">Precios por revisar</h1>
        <p className="text-[13px] text-dim">
          Ventas de la caja cuyo precio, IVA o SKU no coincide con la base (ni con lo vigente en las últimas {windowHours} horas), o con un producto desconocido. La venta ya se cobró y se
          guardó, pero <b>no se factura sola</b> (ni se reintenta) hasta que usted la decida. A las 2 h se marca atrasada; a las 4 h, en rojo.
        </p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-bold">
          Retenidas <span className="text-[14px] font-medium text-dim">({held.length} · {formatCOP(total)})</span>
        </h2>
        {held.length === 0 ? <p className="text-[14px] text-ok-ink">✓ No hay ventas retenidas por precio.</p> : held.map((r) => <Card key={r.id} r={r} onDone={refresh} />)}
      </section>

      {decided.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold">Decididas recientemente</h2>
          <div className="bg-surface rounded-xl border border-line overflow-x-auto">
            <table className="w-full min-w-[640px] text-[14px]">
              <thead className="bg-subtle text-left text-[13px] text-body">
                <tr><th className="px-4 py-2">Venta</th><th className="px-4 py-2">Decisión</th><th className="px-4 py-2">Quién y cuándo</th><th className="px-4 py-2">Nota</th><th className="px-4 py-2 text-right">Monto</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {decided.map((d) => (
                  <tr key={d.local_number} className="align-top">
                    <td className="px-4 py-2 whitespace-nowrap">{d.local_number}{d.invoice_name ? <div className="text-[12px] text-dim">{d.invoice_name}</div> : null}</td>
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-[12px] font-semibold ${d.decision === "aprobada" ? "bg-ok-soft text-ok-ink" : "bg-off-soft text-off-ink"}`}>{d.decision === "aprobada" ? "Aprobada" : "Anulada"}</span>
                    </td>
                    <td className="px-4 py-2 text-[13px]">{d.by_name ?? "—"}<div className="text-[12px] text-dim">{d.decided_at ? when(d.decided_at) : ""}</div></td>
                    <td className="px-4 py-2 text-[13px] max-w-xs break-words">{d.note ?? "—"}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{formatCOP(d.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
