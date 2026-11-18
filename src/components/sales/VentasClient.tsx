"use client";

import { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/caja/Sidebar";
import { useConnection } from "@/hooks/useConnection";
import { printTicket } from "@/lib/client/print";
import { formatCOP } from "@/lib/money";
import type { Role } from "@/lib/permissions";
import type { ReceiptFilter, SaleListRow } from "@/lib/sales";
import PaymentCell from "./PaymentCell";
import { missingRequiredReceipt, ReceiptCell } from "./ReceiptViewer";
import SaleActionButton from "./SaleActionButton";
import { statusInfo } from "./status";

const fmtTime = new Intl.DateTimeFormat("es-CO", { hour: "2-digit", minute: "2-digit", timeZone: "America/Bogota" });

const RECEIPT_FILTERS: [ReceiptFilter, string][] = [
  ["todos", "Todas"],
  ["con", "Con comprobante"],
  ["sin", "Sin comprobante"],
  ["pendiente", "Comprobante pendiente"],
];

export default function VentasClient({
  user,
  today,
  yesterday,
}: {
  user: { name: string; role: Role };
  today: string;
  yesterday: string;
}) {
  const isAdmin = user.role === "admin";
  const { online, pending } = useConnection();
  const [date, setDate] = useState(today);
  const [sales, setSales] = useState<SaleListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null); // fila con el error desplegado (solo admin)
  const [receiptFilter, setReceiptFilter] = useState<ReceiptFilter>("todos");

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const res = await fetch(`/api/sales?date=${date}&comprobante=${receiptFilter}`, { cache: "no-store" });
        if (res.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!res.ok) throw new Error(`Error ${res.status}`);
        const d = (await res.json()) as { sales: SaleListRow[] };
        setSales(d.sales);
        setError("");
      } catch {
        setError("No se pudo cargar el historial (¿sin conexión con el servidor?).");
      } finally {
        setLoading(false);
      }
    },
    [date, receiptFilter]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    if (date !== today) return;
    const iv = setInterval(() => load(true), 30_000); // el día de hoy se refresca solo
    return () => clearInterval(iv);
  }, [load, date, today]);

  const valid = sales.filter((s) => s.status !== "anulada");
  const total = valid.reduce((a, s) => a + s.total, 0);

  return (
    <div className="h-screen flex flex-col md:flex-row bg-app overflow-hidden">
      <Sidebar userName={user.name} role={user.role} online={online} pending={pending} active="ventas" />

      <main className="flex-1 min-w-0 flex flex-col p-3 sm:p-5 gap-4">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-fg">Historial de ventas</h1>
            <p className="text-[13px] text-dim">
              {isAdmin ? "Todas las ventas del día seleccionado." : "Tus ventas de hoy y de ayer."}
            </p>
          </div>
          <div className="flex items-end gap-3">
            <div className="inline-flex rounded-lg border border-field overflow-hidden bg-surface">
              {[
                ["Hoy", today],
                ["Ayer", yesterday],
              ].map(([name, d]) => (
                <button
                  key={name}
                  onClick={() => setDate(d)}
                  className={`px-4 min-h-11 text-[14px] font-medium ${date === d ? "bg-brand text-white" : "text-body hover:bg-hover"}`}
                >
                  {name}
                </button>
              ))}
            </div>
            {isAdmin && (
              <label className="text-[13px] font-semibold text-body">
                Fecha
                <input
                  type="date"
                  value={date}
                  max={today}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                  className="mt-1 block border border-field rounded-lg px-3 min-h-11 text-[14px] text-fg bg-surface"
                />
              </label>
            )}
            <button
              onClick={() => load()}
              className="px-4 min-h-11 rounded-lg border border-field bg-surface text-[14px] font-medium text-body"
            >
              Actualizar
            </button>
          </div>
        </div>

        {/* Filtro de comprobantes */}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por comprobante">
          {RECEIPT_FILTERS.map(([id, name]) => (
            <button
              key={id}
              onClick={() => setReceiptFilter(id)}
              aria-pressed={receiptFilter === id}
              className={`px-3 min-h-11 rounded-lg border text-[13px] font-medium ${receiptFilter === id ? "bg-brand border-brand text-white" : "bg-surface border-field text-body hover:bg-hover"}`}
            >
              {name}
            </button>
          ))}
        </div>

        {error && <div className="text-[14px] bg-err-soft text-err-ink rounded-lg px-4 py-2">{error}</div>}

        {/* ---------- Celular y tablet vertical: una tarjeta por venta ---------- */}
        <div className="lg:hidden flex-1 overflow-y-auto space-y-2">
          {sales.map((s) => {
            const st = s.price_review_status === "pendiente" ? { label: isAdmin ? "Precio por revisar" : "En revisión", cls: "bg-warn-soft text-warn-ink" } : statusInfo(s.status);
            return (
              <div
                key={s.id}
                className={`rounded-xl border p-3 space-y-2 ${s.status === "anulada" ? "opacity-60" : ""} ${missingRequiredReceipt(s) ? "bg-warn-soft border-warn-line" : "bg-surface border-line"}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-fg">{s.invoice_name ?? s.local_number}</div>
                    <div className="text-[12px] text-dim">
                      {fmtTime.format(new Date(s.created_at))} · {s.local_number} · {s.cashier_name}
                    </div>
                  </div>
                  <span className={`shrink-0 px-2 py-0.5 rounded-full text-[12px] font-semibold ${st.cls}`}>{st.label}</span>
                </div>
                <div className="text-[14px] text-body">
                  <div className="truncate">{s.customer_name}</div>
                  <div className="text-[12px] text-dim">{s.customer_identification}</div>
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div className="text-[13px] text-dim">
                    <PaymentCell s={s} />
                  </div>
                  <div className="text-xl font-bold text-fg">{formatCOP(s.total)}</div>
                </div>
                <ReceiptCell s={s} isAdmin={isAdmin} onChanged={() => load(true)} />
                <div className="flex items-center gap-2 flex-wrap pt-1">
                  <button onClick={() => printTicket(s.id)} className="px-3 min-h-11 rounded-lg border border-field text-[14px] font-medium text-body">
                    Reimprimir
                  </button>
                  {isAdmin && !!s.last_error && (
                    <button onClick={() => setOpen(open === s.id ? null : s.id)} className="px-3 min-h-11 rounded-lg border border-field text-[14px] font-medium text-body">
                      {open === s.id ? "Ocultar error" : "Ver error"}
                    </button>
                  )}
                  {isAdmin && <SaleActionButton saleId={s.id} status={s.price_review_status === "pendiente" ? "retenida" : s.status} onDone={() => load(true)} />}
                </div>
                {open === s.id && s.last_error && (
                  <div className="bg-err-soft text-err-ink rounded-lg px-3 py-2 text-[13px] whitespace-pre-wrap break-words">{s.last_error}</div>
                )}
              </div>
            );
          })}
          {!loading && sales.length === 0 && <div className="bg-surface rounded-xl border border-line py-10 text-center text-dim">No hay ventas en este día.</div>}
          {loading && <div className="bg-surface rounded-xl border border-line py-10 text-center text-dim">Cargando…</div>}
        </div>

        {/* ---------- Tablet horizontal y PC: tabla ---------- */}
        <div className="hidden lg:block flex-1 overflow-auto bg-surface rounded-xl border border-line">
          <table className="w-full text-[14px]">
            <thead className="bg-subtle text-left text-[13px] text-body sticky top-0">
              <tr>
                <th className="px-3 py-2">Hora</th>
                <th className="px-3 py-2">Venta</th>
                <th className="px-3 py-2">Factura</th>
                <th className="px-3 py-2">Cliente</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Medio de pago</th>
                <th className="px-3 py-2">Comprobante</th>
                <th className="px-3 py-2">Cajero</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-fg">
              {sales.map((s) => {
                const st = s.price_review_status === "pendiente" ? { label: isAdmin ? "Precio por revisar" : "En revisión", cls: "bg-warn-soft text-warn-ink" } : statusInfo(s.status);
                const canSeeError = isAdmin && !!s.last_error;
                return (
                  <FragmentRow key={s.id}>
                    <tr className={`${s.status === "anulada" ? "text-dim" : ""} ${missingRequiredReceipt(s) ? "bg-warn-soft" : ""}`}>
                      <td className="px-3 py-2 whitespace-nowrap">{fmtTime.format(new Date(s.created_at))}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{s.local_number}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.invoice_name ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div className="leading-tight">{s.customer_name}</div>
                        <div className="text-[12px] text-dim">{s.customer_identification}</div>
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap font-semibold">{formatCOP(s.total)}</td>
                      <td className="px-3 py-2">
                        <PaymentCell s={s} />
                      </td>
                      <td className="px-3 py-2">
                        <ReceiptCell s={s} isAdmin={isAdmin} onChanged={() => load(true)} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{s.cashier_name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded-full text-[12px] font-semibold ${st.cls}`}>{st.label}</span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            onClick={() => printTicket(s.id)}
                            className="px-3 min-h-11 rounded-md border border-field text-[13px] font-medium text-body hover:bg-hover"
                          >
                            Reimprimir
                          </button>
                          {canSeeError && (
                            <button
                              onClick={() => setOpen(open === s.id ? null : s.id)}
                              className="px-3 min-h-11 rounded-md border border-field text-[13px] font-medium text-body hover:bg-hover"
                            >
                              {open === s.id ? "Ocultar error" : "Ver error"}
                            </button>
                          )}
                          {isAdmin && <SaleActionButton saleId={s.id} status={s.price_review_status === "pendiente" ? "retenida" : s.status} onDone={() => load(true)} />}
                        </div>
                      </td>
                    </tr>
                    {open === s.id && s.last_error && (
                      <tr className="bg-err-soft">
                        <td colSpan={10} className="px-4 py-2 text-[13px] text-err-ink whitespace-pre-wrap break-words">
                          {s.last_error}
                        </td>
                      </tr>
                    )}
                  </FragmentRow>
                );
              })}
              {!loading && sales.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-dim">
                    No hay ventas en este día.
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-dim">
                    Cargando…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="text-[14px] text-body">
          {valid.length} venta{valid.length === 1 ? "" : "s"} · Total <b>{formatCOP(total)}</b>
          {sales.length !== valid.length && <span className="text-dim"> (sin contar {sales.length - valid.length} anulada/s)</span>}
        </div>
      </main>
    </div>
  );
}

function FragmentRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
