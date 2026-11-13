import { requirePage } from "@/lib/auth";
import { query } from "@/lib/db";
import { formatCOP } from "@/lib/money";
import { paymentLabel } from "@/lib/payments";
import { isDateStr, SALE_DAY_SQL, todayBogota } from "@/lib/sales";
import { statusInfo } from "@/components/sales/status";
import { NOT_REVENUE_SQL } from "@/lib/sale-states";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Reportes" };

// Las ventas 'anulada' no cuentan en ningún reporte. Se cuentan todas las demás (facturadas o no) y se muestra el desglose por estado.
// Tampoco cuentan 'esperando_pago' ni 'pago_fallido' (cobros del kiosco donde no entró dinero): ver NOT_REVENUE.
const WHERE = `${SALE_DAY_SQL} BETWEEN $1::date AND $2::date AND s.status NOT IN (${NOT_REVENUE_SQL})`;

const th = "px-4 py-2";
const card = "bg-surface rounded-xl border border-line overflow-x-auto";
const head = "bg-subtle text-left text-[13px] text-body";

export default async function ReportesPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  await requirePage("/admin");
  const sp = await searchParams;
  const today = todayBogota();
  let from = isDateStr(sp.from) ? sp.from : today;
  let to = isDateStr(sp.to) ? sp.to : from;
  if (from > to) [from, to] = [to, from];
  const p = [from, to];

  const [totals, byStatus, byCashier, byPay, payDetail, top, byDay, toReview] = await Promise.all([
    query<{ n: number; subtotal: number; tax: number; total: number; facturado: number; n_facturadas: number }>(
      `SELECT count(*)::int n, coalesce(sum(s.subtotal),0)::float8 subtotal, coalesce(sum(s.tax_total),0)::float8 tax, coalesce(sum(s.total),0)::float8 total,
              coalesce(sum(s.total) FILTER (WHERE s.status = 'invoiced'),0)::float8 facturado,
              (count(*) FILTER (WHERE s.status = 'invoiced'))::int n_facturadas
         FROM sales s WHERE ${WHERE}`, p),
    query<{ status: string; n: number; total: number }>(
      `SELECT s.status, count(*)::int n, sum(s.total)::float8 total FROM sales s WHERE ${WHERE} GROUP BY s.status ORDER BY s.status`, p),
    query<{ name: string; n: number; total: number }>(
      `SELECT u.name, count(*)::int n, sum(s.total)::float8 total FROM sales s JOIN users u ON u.id = s.cashier_id
        WHERE ${WHERE} GROUP BY u.name ORDER BY total DESC`, p),
    query<{ payment_method: string; n: number; total: number }>(
      `SELECT s.payment_method, count(*)::int n, sum(s.total)::float8 total FROM sales s WHERE ${WHERE} GROUP BY s.payment_method ORDER BY total DESC`, p),
    query<{ payment_method: string; local_number: string; payment_reference: string | null; total: number; day: string; invoice_name: string | null }>(
      `SELECT s.payment_method, s.local_number, s.payment_reference, s.total::float8 total, ${SALE_DAY_SQL}::text AS day, s.invoice_name
         FROM sales s WHERE ${WHERE} AND s.payment_method <> 'efectivo' ORDER BY s.payment_method, COALESCE(s.created_at_device, s.created_at)`, p),
    query<{ sku: string | null; name: string; qty: number; total: number }>(
      `SELECT max(si.sku) AS sku, si.name, sum(si.quantity)::float8 qty, sum(si.line_total)::float8 total
         FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE ${WHERE}
        GROUP BY si.name ORDER BY qty DESC, total DESC LIMIT 10`, p),
    query<{ day: string; n: number; total: number }>(
      `SELECT ${SALE_DAY_SQL}::text AS day, count(*)::int n, sum(s.total)::float8 total FROM sales s WHERE ${WHERE} GROUP BY 1 ORDER BY 1`, p),
    // Pagos electrónicos que un admin aún debe resolver (todas las fechas: no se esconden por el rango del reporte).
    // Los marcados "para reembolso" ya están resueltos y no se cuentan.
    query<{ n: number; total: number }>(
      `SELECT count(*)::int n, coalesce(sum(total),0)::float8 total FROM sales
        WHERE status IN ('pago_por_revisar','pago_tardio') AND refund_requested_at IS NULL`),
  ]);
  const review = toReview.rows[0];

  const t = totals.rows[0];
  const refsByMethod = new Map<string, typeof payDetail.rows>();
  for (const r of payDetail.rows) refsByMethod.set(r.payment_method, [...(refsByMethod.get(r.payment_method) ?? []), r]);

  return (
    <div className="space-y-6 max-w-6xl text-fg">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Reportes</h1>
          <p className="text-[13px] text-dim">Excluye las ventas anuladas. Incluye ventas facturadas y por facturar (ver desglose por estado).</p>
        </div>
        <form className="flex items-end gap-3">
          <label className="text-[13px] font-semibold text-body">
            Desde
            <input type="date" name="from" defaultValue={from} max={today} className="mt-1 block border border-field rounded-lg px-3 min-h-11 text-[14px] bg-surface text-fg" />
          </label>
          <label className="text-[13px] font-semibold text-body">
            Hasta
            <input type="date" name="to" defaultValue={to} max={today} className="mt-1 block border border-field rounded-lg px-3 min-h-11 text-[14px] bg-surface text-fg" />
          </label>
          <button className="px-5 min-h-11 rounded-lg bg-brand text-white font-semibold text-[14px]">Ver</button>
          <a href="/admin/reportes" className="px-4 inline-flex items-center min-h-11 rounded-lg border border-field bg-surface text-[14px] text-body">Hoy</a>
        </form>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          ["Ventas (no anuladas)", String(t.n)],
          ["Subtotal (sin IVA)", formatCOP(t.subtotal)],
          ["IVA", formatCOP(t.tax)],
        ].map(([k, v]) => (
          <div key={k} className="bg-surface rounded-xl border border-line p-4">
            <div className="text-[13px] text-dim">{k}</div>
            <div className="text-2xl font-bold">{v}</div>
          </div>
        ))}
      </div>

      {/* Pagos del kiosco sin resolver: NO están en "recaudado" ni en "facturado" hasta que un admin los resuelva */}
      <div
        className={`rounded-xl border px-4 py-3 text-[14px] flex items-center justify-between gap-4 flex-wrap ${
          review.n > 0 ? "border-review-line bg-review-soft text-review-ink" : "border-line bg-surface text-body"
        }`}
      >
        <span>
          <b>Pagos por revisar: {formatCOP(review.total)}</b> ({review.n} {review.n === 1 ? "venta" : "ventas"}) — pagos electrónicos del
          autoservicio que no se facturaron solos. No incluidos en los totales de abajo.
        </span>
        <a href="/admin/pagos-por-revisar" className="inline-flex items-center min-h-11 font-semibold text-brand-text underline whitespace-nowrap">
          Revisar →
        </a>
      </div>

      {/* Dos totales visibles: lo cobrado en caja vs. lo que ya está facturado en Siigo */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl border border-line p-4">
          <div className="text-[13px] text-dim">Total recaudado</div>
          <div className="text-2xl font-bold">{formatCOP(t.total)}</div>
          <div className="text-[12px] text-dim">Todas las ventas no anuladas ({t.n})</div>
        </div>
        <div className="bg-surface rounded-xl border border-line p-4">
          <div className="text-[13px] text-dim">Total facturado</div>
          <div className="text-2xl font-bold">{formatCOP(t.facturado)}</div>
          <div className="text-[12px] text-dim">Solo ventas facturadas ({t.n_facturadas})</div>
        </div>
        {Math.round(t.total - t.facturado) === 0 ? (
          <div className="rounded-xl border border-ok-line bg-ok-soft p-4">
            <div className="text-[13px] text-ok-ink">Diferencia</div>
            <div className="text-2xl font-bold text-ok-ink">Coinciden ✓</div>
            <div className="text-[12px] text-ok-ink">Todo lo recaudado está facturado</div>
          </div>
        ) : (
          <div className="rounded-xl border-2 border-err-line bg-err-soft p-4">
            <div className="text-[13px] font-semibold text-err-ink">⚠ Diferencia: recaudado sin facturar</div>
            <div className="text-2xl font-bold text-err-ink">{formatCOP(t.total - t.facturado)}</div>
            <div className="text-[12px] text-err-ink">
              {t.n - t.n_facturadas} venta(s) pendientes, fallidas o por revisar. Ver “Por estado” y Configuración.
            </div>
          </div>
        )}
      </div>

      <section className={card}>
        <h2 className="px-4 pt-3 font-semibold">Por estado</h2>
        <table className="w-full text-[14px] mt-2">
          <thead className={head}><tr><th className={th}>Estado</th><th className={`${th} text-right`}>Ventas</th><th className={`${th} text-right`}>Total</th></tr></thead>
          <tbody className="divide-y divide-line">
            {byStatus.rows.map((r) => (
              <tr key={r.status}>
                <td className={th}><span className={`px-2 py-0.5 rounded-full text-[12px] font-semibold ${statusInfo(r.status).cls}`}>{statusInfo(r.status).label}</span></td>
                <td className={`${th} text-right`}>{r.n}</td>
                <td className={`${th} text-right`}>{formatCOP(r.total)}</td>
              </tr>
            ))}
            {!byStatus.rows.length && <tr><td colSpan={3} className="px-4 py-6 text-center text-dim">Sin ventas en este rango.</td></tr>}
          </tbody>
        </table>
      </section>

      {from !== to && (
        <section className={card}>
          <h2 className="px-4 pt-3 font-semibold">Por día</h2>
          <table className="w-full text-[14px] mt-2">
            <thead className={head}><tr><th className={th}>Fecha</th><th className={`${th} text-right`}>Ventas</th><th className={`${th} text-right`}>Total</th></tr></thead>
            <tbody className="divide-y divide-line">
              {byDay.rows.map((r) => (
                <tr key={r.day}><td className={th}>{r.day}</td><td className={`${th} text-right`}>{r.n}</td><td className={`${th} text-right`}>{formatCOP(r.total)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <section className={card}>
          <h2 className="px-4 pt-3 font-semibold">Por cajero</h2>
          <table className="w-full text-[14px] mt-2">
            <thead className={head}><tr><th className={th}>Cajero</th><th className={`${th} text-right`}>Ventas</th><th className={`${th} text-right`}>Total</th></tr></thead>
            <tbody className="divide-y divide-line">
              {byCashier.rows.map((r) => (
                <tr key={r.name}><td className={th}>{r.name}</td><td className={`${th} text-right`}>{r.n}</td><td className={`${th} text-right`}>{formatCOP(r.total)}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className={card}>
          <h2 className="px-4 pt-3 font-semibold">Por medio de pago</h2>
          <table className="w-full text-[14px] mt-2">
            <thead className={head}><tr><th className={th}>Medio</th><th className={`${th} text-right`}>Ventas</th><th className={`${th} text-right`}>Total</th></tr></thead>
            <tbody className="divide-y divide-line">
              {byPay.rows.map((r) => {
                const refs = refsByMethod.get(r.payment_method) ?? [];
                return (
                  <tr key={r.payment_method} className="align-top">
                    <td className={th}>
                      {paymentLabel(r.payment_method)}
                      {refs.length > 0 && (
                        <details className="mt-1">
                          <summary className="text-[12px] text-brand-text cursor-pointer">Ver referencias ({refs.length})</summary>
                          <ul className="mt-1 text-[12px] text-soft space-y-0.5">
                            {refs.map((x) => (
                              <li key={x.local_number}>
                                {x.day} · {x.local_number}{x.invoice_name ? ` (${x.invoice_name})` : ""} · {formatCOP(x.total)} · <b>Ref. {x.payment_reference ?? "—"}</b>
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                    <td className={`${th} text-right`}>{r.n}</td>
                    <td className={`${th} text-right`}>{formatCOP(r.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      <section className={card}>
        <h2 className="px-4 pt-3 font-semibold">Top 10 productos</h2>
        <table className="w-full text-[14px] mt-2">
          <thead className={head}><tr><th className={th}>#</th><th className={th}>Producto</th><th className={th}>SKU</th><th className={`${th} text-right`}>Unidades</th><th className={`${th} text-right`}>Total</th></tr></thead>
          <tbody className="divide-y divide-line">
            {top.rows.map((r, i) => (
              <tr key={r.name}><td className={th}>{i + 1}</td><td className={th}>{r.name}</td><td className={th}>{r.sku ?? "—"}</td><td className={`${th} text-right`}>{r.qty}</td><td className={`${th} text-right`}>{formatCOP(r.total)}</td></tr>
            ))}
            {!top.rows.length && <tr><td colSpan={5} className="px-4 py-6 text-center text-dim">Sin ventas en este rango.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
