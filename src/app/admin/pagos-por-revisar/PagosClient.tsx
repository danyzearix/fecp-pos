"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { statusInfo } from "@/components/sales/status";
import { formatCOP } from "@/lib/money";

export type PagoRow = {
  id: string;
  local_number: string;
  status: string;
  source: string;
  total: number;
  created_at: string;
  payment_failure_reason: string | null;
  epayco_ref: string | null;
  payment_reference: string | null;
  notify_email: string | null;
  refund_requested_at: string | null;
  customer_id: string | null;
  customer_name: string | null;
  cashier: string;
  refund_by: string | null;
  refs: { ref: string; outcome: string; reason: string | null }[];
  /** llegó un aviso FIRMADO del webhook, pero sin la referencia larga (no se pudo consultar a ePayco) */
  webhook_hint_at: string | null;
  webhook_hint_ref: string | null;
};

/** Un SEGUNDO pago aprobado de una venta que ya estaba pagada (p. ej. por QR y en pantalla). Nunca se factura. */
export type DuplicadoRow = {
  ref_payco: string;
  amount: number | null;
  reason: string | null;
  source: string | null;
  started_at: string;
  short_ref: string | null;
  refund_requested_at: string | null;
  refund_by: string | null;
  local_number: string;
  status: string;
  total: number;
  invoice_name: string | null;
};

const card = "bg-surface rounded-xl border border-line overflow-x-auto";
const head = "bg-subtle text-left text-[13px] text-body";
const when = (iso: string) => new Date(iso).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" });

function Customer({ r }: { r: PagoRow }) {
  return (
    <div>
      <div>{r.customer_name ?? "Consumidor final"}</div>
      {r.customer_id && <div className="text-[12px] text-dim">{r.customer_id}</div>}
    </div>
  );
}

/** Aviso firmado del webhook que no se pudo confirmar (falta la referencia larga). No decide nada: es una pista para el admin. */
function WebhookHint({ r }: { r: PagoRow }) {
  if (!r.webhook_hint_at) return null;
  return (
    <div className="mt-1 text-[12px] rounded-md bg-brand-soft text-brand-ink px-2 py-1 max-w-xs break-words">
      ePayco avisó de un pago ({when(r.webhook_hint_at)}, ref. corta {r.webhook_hint_ref ?? "—"}) pero <b>sin la referencia larga</b>: el sistema no pudo confirmarlo.
      Verifique en el panel de ePayco y pegue aquí la referencia larga.
    </div>
  );
}

function Refs({ r }: { r: PagoRow }) {
  const shown = r.refs.length ? r.refs : r.epayco_ref ? [{ ref: r.epayco_ref, outcome: "", reason: null }] : [];
  if (!shown.length) return <span className="text-dim">—</span>;
  return (
    <div className="space-y-1">
      {shown.map((x) => (
        <div key={x.ref} className="text-[12px]">
          <span className="font-mono break-all">{x.ref}</span>
          {x.outcome && <span className="text-dim"> · {x.outcome}</span>}
        </div>
      ))}
      {r.payment_reference && <div className="text-[12px] text-dim">Ref. Davipay: {r.payment_reference}</div>}
    </div>
  );
}

/** Botón con confirmación en dos pasos (no hay diálogos del navegador: se confirma en la misma fila). */
function ReviewActions({ r, onDone }: { r: PagoRow; onDone: () => void }) {
  const [ask, setAsk] = useState<"" | "facturar" | "reembolso">("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function run(kind: "facturar" | "reembolso") {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/admin/pagos/${r.id}/${kind}`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) setMsg(d.error ?? `Error ${res.status}`);
      else if (kind === "facturar") setMsg(d.status === "invoiced" ? `Facturada ${d.invoice_name ?? ""}` : d.error ?? `Estado: ${d.status}`);
      else setMsg("Marcada para reembolso");
      setAsk("");
      onDone();
    } catch {
      setMsg("Sin conexión con el servidor");
    } finally {
      setBusy(false);
    }
  }

  if (ask) {
    return (
      <div className="space-y-2 max-w-[260px]">
        <p className="text-[12px] text-body">
          {ask === "facturar"
            ? "¿Confirma? Verifique en el panel de ePayco que el dinero SÍ entró. Se generará la factura electrónica."
            : "¿Confirma? Solo deja constancia: el reembolso se hace en el panel de ePayco. La venta no se facturará."}
        </p>
        <div className="flex gap-2">
          <button onClick={() => run(ask)} disabled={busy} className={`px-3 min-h-11 rounded-md text-white text-[13px] font-semibold disabled:opacity-50 ${ask === "facturar" ? "bg-brand" : "bg-err"}`}>
            {busy ? "Procesando…" : ask === "facturar" ? "Sí, facturar" : "Sí, marcar"}
          </button>
          <button onClick={() => setAsk("")} disabled={busy} className="px-3 min-h-11 rounded-md border border-field text-[13px] text-body">
            No
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setAsk("facturar")} className="px-3 min-h-11 rounded-md border border-brand text-brand-text text-[13px] font-medium hover:bg-brand-soft">
          Facturar
        </button>
        <button onClick={() => setAsk("reembolso")} className="px-3 min-h-11 rounded-md border border-err-line text-err-ink text-[13px] font-medium hover:bg-err-soft">
          Marcar para reembolso
        </button>
      </div>
      {msg && <div className="text-[12px] text-soft">{msg}</div>}
    </div>
  );
}

/** "Marcar para reembolso" de un pago duplicado, con confirmación en la misma fila */
function DuplicateRefund({ d, onDone }: { d: DuplicadoRow; onDone: () => void }) {
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function run() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/admin/pagos/duplicados/reembolso", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref_payco: d.ref_payco }) });
      const j = await res.json().catch(() => ({}));
      setMsg(res.ok ? "Marcado para reembolso" : j.error ?? `Error ${res.status}`);
      setAsk(false);
      if (res.ok) onDone();
    } catch {
      setMsg("Sin conexión con el servidor");
    } finally {
      setBusy(false);
    }
  }
  if (ask) {
    return (
      <div className="space-y-2 max-w-[260px]">
        <p className="text-[12px] text-body">¿Confirma? Solo deja constancia: el reembolso se hace en el panel de ePayco.</p>
        <div className="flex gap-2">
          <button onClick={run} disabled={busy} className="px-3 min-h-11 rounded-md bg-err text-white text-[13px] font-semibold disabled:opacity-50">{busy ? "Procesando…" : "Sí, marcar"}</button>
          <button onClick={() => setAsk(false)} disabled={busy} className="px-3 min-h-11 rounded-md border border-field text-[13px] text-body">No</button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-1.5">
      <button onClick={() => setAsk(true)} className="px-3 min-h-11 rounded-md border border-err-line text-err-ink text-[13px] font-medium hover:bg-err-soft">Marcar para reembolso</button>
      {msg && <div className="text-[12px] text-soft">{msg}</div>}
    </div>
  );
}

function VerifyBox({ r, onDone }: { r: PagoRow; onDone: () => void }) {
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function run() {
    setBusy(true);
    setMsg("");
    try {
      const res = await fetch(`/api/admin/pagos/${r.id}/verificar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ref_payco: ref }) });
      const d = await res.json().catch(() => ({}));
      setMsg(!res.ok ? d.error ?? `Error ${res.status}` : d.message ?? `Resultado: ${d.outcome}`);
      if (res.ok) {
        setRef("");
        onDone();
      }
    } catch {
      setMsg("Sin conexión con el servidor");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-1.5 min-w-[260px]">
      <div className="flex gap-2">
        <input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="Enlace con ref_payco= o referencia larga"
          className="flex-1 border border-field rounded-md px-2 min-h-11 text-[13px] bg-surface text-fg"
        />
        <button onClick={run} disabled={busy || !ref.trim()} className="px-3 min-h-11 rounded-md border border-brand text-brand-text text-[13px] font-medium hover:bg-brand-soft disabled:opacity-50">
          {busy ? "…" : "Verificar"}
        </button>
      </div>
      {msg && <div className="text-[12px] text-soft">{msg}</div>}
    </div>
  );
}

export default function PagosClient({ review, unconfirmed, refunds, duplicates }: { review: PagoRow[]; unconfirmed: PagoRow[]; refunds: PagoRow[]; duplicates: DuplicadoRow[] }) {
  const router = useRouter();
  const refresh = () => router.refresh();
  const total = review.reduce((a, r) => a + r.total, 0);

  return (
    <div className="space-y-6 max-w-6xl min-w-0 text-fg">
      <div>
        <h1 className="text-2xl font-bold">Pagos por revisar</h1>
        <p className="text-[13px] text-dim">
          Pagos electrónicos (ePayco) que NO se facturaron solos: la verificación falló, algo no coincidió o el pago llegó fuera de tiempo. Nada de esto cuenta como
          recaudado ni facturado hasta que usted lo resuelva.
        </p>
      </div>

      {/* ---------- Por revisar ---------- */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">
          Pendientes de decisión <span className="text-[14px] font-medium text-dim">({review.length} · {formatCOP(total)})</span>
        </h2>
        {review.length === 0 ? (
          <p className="text-[14px] text-ok-ink">✓ No hay pagos por revisar.</p>
        ) : (
          <div className={card}>
            <table className="w-full text-[14px]">
              <thead className={head}>
                <tr>
                  <th className="px-4 py-2">Fecha</th>
                  <th className="px-4 py-2">Venta</th>
                  <th className="px-4 py-2">Cliente</th>
                  <th className="px-4 py-2 text-right">Monto</th>
                  <th className="px-4 py-2">Estado y motivo</th>
                  <th className="px-4 py-2">ref_payco</th>
                  <th className="px-4 py-2">Decisión</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {review.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-2 whitespace-nowrap text-[13px]">{when(r.created_at)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {r.local_number}
                      <div className="text-[12px] text-dim">{r.source === "caja" ? `Caja · ${r.cashier}` : "Autoservicio"}</div>
                    </td>
                    <td className="px-4 py-2"><Customer r={r} /></td>
                    <td className="px-4 py-2 text-right whitespace-nowrap font-semibold">{formatCOP(r.total)}</td>
                    <td className="px-4 py-2 max-w-sm">
                      <span className={`px-2 py-0.5 rounded-full text-[12px] font-semibold ${statusInfo(r.status).cls}`}>{statusInfo(r.status).label}</span>
                      <div className="text-[12px] text-soft mt-1 break-words">{r.payment_failure_reason ?? "—"}</div>
                      <WebhookHint r={r} />
                    </td>
                    <td className="px-4 py-2"><Refs r={r} /></td>
                    <td className="px-4 py-2"><ReviewActions r={r} onDone={refresh} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- Pagos duplicados ---------- */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">
          Pagos duplicados{" "}
          <span className="text-[14px] font-medium text-dim">
            ({duplicates.filter((d) => !d.refund_requested_at).length} pendientes · {formatCOP(duplicates.filter((d) => !d.refund_requested_at).reduce((a, d) => a + (d.amount ?? 0), 0))})
          </span>
        </h2>
        <p className="text-[13px] text-dim">
          Una venta que se pagó DOS veces (por ejemplo, por QR en el celular y también en la pantalla). El primer pago se facturó normalmente; este segundo pago
          NO se factura ni cuenta como recaudado. Reembólselo en el panel de ePayco y márquelo aquí como constancia.
        </p>
        {duplicates.length === 0 ? (
          <p className="text-[14px] text-ok-ink">✓ No hay pagos duplicados.</p>
        ) : (
          <div className={card}>
            <table className="w-full min-w-[760px] text-[14px]">
              <thead className={head}>
                <tr>
                  <th className="px-4 py-2">Fecha</th>
                  <th className="px-4 py-2">Venta</th>
                  <th className="px-4 py-2 text-right">Monto del duplicado</th>
                  <th className="px-4 py-2">Motivo</th>
                  <th className="px-4 py-2">ref_payco</th>
                  <th className="px-4 py-2">Reembolso</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {duplicates.map((d) => (
                  <tr key={d.ref_payco} className="align-top">
                    <td className="px-4 py-2 whitespace-nowrap text-[13px]">{when(d.started_at)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {d.local_number}
                      <div className="text-[12px] text-dim">{statusInfo(d.status).label}{d.invoice_name ? ` · ${d.invoice_name}` : ""}</div>
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap font-semibold">{d.amount != null ? formatCOP(d.amount) : "—"}</td>
                    <td className="px-4 py-2 max-w-xs text-[13px] text-err-ink font-medium break-words">{d.reason ?? "Pago duplicado, reembolsar"}</td>
                    <td className="px-4 py-2 text-[12px]">
                      <span className="font-mono break-all">{d.ref_payco}</span>
                      {d.short_ref && <div className="text-dim">Ref. Davipay: {d.short_ref}</div>}
                    </td>
                    <td className="px-4 py-2">
                      {d.refund_requested_at ? (
                        <span className="text-[13px] text-soft">Marcado {when(d.refund_requested_at)}{d.refund_by ? ` · ${d.refund_by}` : ""}</span>
                      ) : (
                        <DuplicateRefund d={d} onDone={refresh} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- Cobros sin confirmar ---------- */}
      <section className="space-y-2">
        <h2 className="text-lg font-bold">Cobros sin confirmar <span className="text-[14px] font-medium text-dim">(últimos 7 días)</span></h2>
        <p className="text-[13px] text-dim">
          Cobros que quedaron esperando o vencieron. Si el cliente SÍ pagó pero la pantalla no recibió la referencia, péguela aquí: el servidor la verifica con ePayco
          (monto, factura, moneda, modo de prueba y firma). Si el cobro ya había vencido, el pago aprobado pasa a «Pago tardío» arriba para que usted decida.
        </p>
        {unconfirmed.length === 0 ? (
          <p className="text-[14px] text-dim">No hay cobros sin confirmar.</p>
        ) : (
          <div className={card}>
            <table className="w-full text-[14px]">
              <thead className={head}>
                <tr>
                  <th className="px-4 py-2">Fecha</th>
                  <th className="px-4 py-2">Venta</th>
                  <th className="px-4 py-2 text-right">Monto</th>
                  <th className="px-4 py-2">Estado</th>
                  <th className="px-4 py-2">Verificar con referencia</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {unconfirmed.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-2 whitespace-nowrap text-[13px]">{when(r.created_at)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {r.local_number}
                      <div className="text-[12px] text-dim">{r.source === "caja" ? `Caja · ${r.cashier}` : "Autoservicio"}</div>
                    </td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{formatCOP(r.total)}</td>
                    <td className="px-4 py-2">
                      <span className={`px-2 py-0.5 rounded-full text-[12px] font-semibold ${statusInfo(r.status).cls}`}>{statusInfo(r.status).label}</span>
                      {r.payment_failure_reason && <div className="text-[12px] text-soft mt-1 max-w-xs break-words">{r.payment_failure_reason}</div>}
                      <WebhookHint r={r} />
                    </td>
                    <td className="px-4 py-2"><VerifyBox r={r} onDone={refresh} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ---------- Marcadas para reembolso ---------- */}
      {refunds.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-bold">Marcadas para reembolso <span className="text-[14px] font-medium text-dim">(constancia; el reembolso se hace en ePayco)</span></h2>
          <div className={card}>
            <table className="w-full text-[14px]">
              <thead className={head}>
                <tr>
                  <th className="px-4 py-2">Marcada</th>
                  <th className="px-4 py-2">Venta</th>
                  <th className="px-4 py-2">Cliente</th>
                  <th className="px-4 py-2 text-right">Monto</th>
                  <th className="px-4 py-2">ref_payco</th>
                  <th className="px-4 py-2">Por</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {refunds.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="px-4 py-2 whitespace-nowrap text-[13px]">{r.refund_requested_at ? when(r.refund_requested_at) : "—"}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{r.local_number}</td>
                    <td className="px-4 py-2"><Customer r={r} /></td>
                    <td className="px-4 py-2 text-right whitespace-nowrap">{formatCOP(r.total)}</td>
                    <td className="px-4 py-2"><Refs r={r} /></td>
                    <td className="px-4 py-2">{r.refund_by ?? "—"}</td>
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
