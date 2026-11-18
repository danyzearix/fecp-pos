import { requirePage } from "@/lib/auth";
import { query } from "@/lib/db";
import { formatCOP } from "@/lib/money";
import { paymentLabel } from "@/lib/payments";
import { isDateStr, SALE_DAY_SQL, todayBogota } from "@/lib/sales";
import { statusInfo } from "@/components/sales/status";
import { NOT_REVENUE_SQL } from "@/lib/sale-states";
import { ageLevel, heldText } from "@/lib/price-review-rules";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Reportes" };

// Las ventas 'anulada' no cuentan en ningún reporte. Se cuentan todas las demás (facturadas o no) y se muestra el desglose por estado.
// Tampoco cuentan 'esperando_pago' ni 'pago_fallido' (cobros del kiosco donde no entró dinero): ver NOT_REVENUE.
// Los totales por medio, el recaudado, el crédito y el cuadre de efectivo salen de sale_payments (una fila por línea de pago).
// "Total recaudado" = lo realmente cobrado (efectivo, tarjeta, transferencia, pago electrónico). El Crédito FECP NO es dinero
// recaudado: queda por cobrar en Siigo y se muestra aparte en "Ventas a crédito".
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

  const [totals, byStatus, byCashier, byPay, payDetail, top, byDay, toReview, creditRows, cashByCashier, priceHeld, annulled] = await Promise.all([
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
    // Totales por medio: desde las LÍNEAS de pago (una venta dividida aporta a cada medio solo lo que se aplicó en él)
    query<{ payment_method: string; n: number; total: number }>(
      `SELECT sp.method AS payment_method, count(DISTINCT s.id)::int n, sum(sp.amount)::float8 total
         FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id WHERE ${WHERE} GROUP BY sp.method ORDER BY total DESC`, p),
    query<{ payment_method: string; local_number: string; payment_reference: string | null; total: number; day: string; invoice_name: string | null }>(
      `SELECT sp.method AS payment_method, s.local_number,
              COALESCE(sp.reference, CASE WHEN sp.method = 'epayco' THEN s.payment_reference END) AS payment_reference,
              sp.amount::float8 total, ${SALE_DAY_SQL}::text AS day, s.invoice_name
         FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
        WHERE ${WHERE} AND sp.method NOT IN ('efectivo','credito_fecp')
        ORDER BY sp.method, COALESCE(s.created_at_device, s.created_at)`, p),
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
    // Ventas a crédito del rango: por cliente, con plazo y fecha de vencimiento
    query<{ ident: string; client: string; local_number: string; invoice_name: string | null; amount: number; credit_days: number | null; due: string | null; day: string }>(
      `SELECT COALESCE(c.identification, '—') AS ident,
              COALESCE(NULLIF(c.company_name,''), NULLIF(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')),''), c.identification, '—') AS client,
              s.local_number, s.invoice_name, sp.amount::float8 AS amount, sp.credit_days, to_char(sp.due_date, 'YYYY-MM-DD') AS due, ${SALE_DAY_SQL}::text AS day
         FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id LEFT JOIN customers c ON c.id = s.customer_id
        WHERE ${WHERE} AND sp.method = 'credito_fecp'
        ORDER BY client, sp.due_date, s.local_number`, p),
    // Cuadre de efectivo: SOLO el efectivo APLICADO a las ventas (no el billete entregado, ni el cambio devuelto)
    query<{ name: string; n: number; total: number }>(
      `SELECT u.name, count(DISTINCT s.id)::int n, sum(sp.amount)::float8 total
         FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id JOIN users u ON u.id = s.cashier_id
        WHERE ${WHERE} AND sp.method = 'efectivo' GROUP BY u.name ORDER BY total DESC`, p),
    // Ventas retenidas por precio por revisar (todas las fechas: no se esconden por el rango del reporte)
    query<{ n: number; total: number; oldest: number | null }>(
      `SELECT count(*)::int AS n, coalesce(sum(total),0)::float8 AS total, max(extract(epoch FROM (now() - price_review_at)) / 60)::float8 AS oldest
         FROM sales WHERE price_review_status = 'pendiente' AND status IN ('pending','failed')`),
    // Ventas ANULADAS con dinero cobrado (no cuentan en recaudado ni en facturado, pero el dinero está en caja/cuenta)
    query<{ local_number: string; invoice_name: string | null; cashier: string; day: string; cobrado: number; efectivo: number; note: string | null; by_name: string | null }>(
      `SELECT s.local_number, s.invoice_name, u.name AS cashier, ${SALE_DAY_SQL}::text AS day,
              coalesce(sum(sp.amount) FILTER (WHERE sp.method <> 'credito_fecp' AND (sp.method <> 'epayco' OR s.payment_status = 'aprobado')), 0)::float8 AS cobrado,
              coalesce(sum(sp.amount) FILTER (WHERE sp.method = 'efectivo'), 0)::float8 AS efectivo,
              COALESCE(s.price_review_note, s.last_error) AS note, ru.name AS by_name
         FROM sales s JOIN users u ON u.id = s.cashier_id LEFT JOIN users ru ON ru.id = s.price_review_by
         JOIN sale_payments sp ON sp.sale_id = s.id
        WHERE ${SALE_DAY_SQL} BETWEEN $1::date AND $2::date AND s.status = 'anulada'
        GROUP BY s.id, u.name, ru.name
       HAVING coalesce(sum(sp.amount) FILTER (WHERE sp.method <> 'credito_fecp' AND (sp.method <> 'epayco' OR s.payment_status = 'aprobado')), 0) > 0
        ORDER BY s.created_at`, p),
  ]);
  const review = toReview.rows[0];
  const held = priceHeld.rows[0];
  const heldLevel = held.n > 0 ? ageLevel(held.oldest ?? 0) : "ok";
  const annulledTotal = annulled.rows.reduce((a, r) => a + r.cobrado, 0);
  const annulledCash = annulled.rows.reduce((a, r) => a + r.efectivo, 0);

  // Recaudado = todo lo cobrado de verdad: todos los medios MENOS el Crédito FECP
  const creditTotal = byPay.rows.filter((r) => r.payment_method === "credito_fecp").reduce((a, r) => a + r.total, 0);
  const recaudado = byPay.rows.filter((r) => r.payment_method !== "credito_fecp").reduce((a, r) => a + r.total, 0);
  const cashTotal = cashByCashier.rows.reduce((a, r) => a + r.total, 0);
  // Ventas a crédito agrupadas por cliente
  const creditByClient = new Map<string, { client: string; ident: string; total: number; rows: typeof creditRows.rows }>();
  for (const r of creditRows.rows) {
    const g = creditByClient.get(r.ident) ?? { client: r.client, ident: r.ident, total: 0, rows: [] };
    g.total += r.amount;
    g.rows.push(r);
    creditByClient.set(r.ident, g);
  }

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

      {/* Ventas de la caja retenidas por precio por revisar: SÍ cuentan como vendidas/recaudadas (el cliente ya pagó) pero NO están facturadas */}
      <div
        className={`rounded-xl border px-4 py-3 text-[14px] flex items-center justify-between gap-4 flex-wrap ${
          held.n === 0 ? "border-line bg-surface text-body" : heldLevel === "critica" ? "border-2 border-err-line bg-err-soft text-err-ink" : "border-warn-line bg-warn-soft text-warn-ink"
        }`}
      >
        <span>
          <b>Precios por revisar: {formatCOP(held.total)}</b> ({held.n} {held.n === 1 ? "venta retenida" : "ventas retenidas"})
          {held.n > 0 && (
            <>
              {" "}— la más antigua lleva {heldText(held.oldest ?? 0)}
              {heldLevel === "critica" ? " · MUY ATRASADA (+4 h)" : heldLevel === "atrasada" ? " · ATRASADA (+2 h)" : ""}. Ya están cobradas pero NO facturadas.
            </>
          )}
        </span>
        <a href="/admin/precios-por-revisar" className="inline-flex items-center min-h-11 font-semibold underline whitespace-nowrap">
          Revisar →
        </a>
      </div>

      {/* Lo realmente cobrado, lo vendido a crédito (por cobrar) y lo facturado en Siigo */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface rounded-xl border border-line p-4">
          <div className="text-[13px] text-dim">Total recaudado</div>
          <div className="text-2xl font-bold">{formatCOP(recaudado)}</div>
          <div className="text-[12px] text-dim">Efectivo, tarjeta, transferencia y pago electrónico</div>
        </div>
        <div className="bg-surface rounded-xl border border-line p-4">
          <div className="text-[13px] text-dim">Ventas a crédito</div>
          <div className="text-2xl font-bold">{formatCOP(creditTotal)}</div>
          <div className="text-[12px] text-dim">Crédito FECP: NO es dinero recaudado (por cobrar en Siigo)</div>
        </div>
        <div className="bg-surface rounded-xl border border-line p-4">
          <div className="text-[13px] text-dim">Total facturado</div>
          <div className="text-2xl font-bold">{formatCOP(t.facturado)}</div>
          <div className="text-[12px] text-dim">Solo ventas facturadas ({t.n_facturadas}) · ventas del rango: {formatCOP(t.total)}</div>
        </div>
        {Math.round(t.total - t.facturado) === 0 ? (
          <div className="rounded-xl border border-ok-line bg-ok-soft p-4">
            <div className="text-[13px] text-ok-ink">Diferencia</div>
            <div className="text-2xl font-bold text-ok-ink">Coinciden ✓</div>
            <div className="text-[12px] text-ok-ink">Todo lo vendido está facturado</div>
          </div>
        ) : (
          <div className="rounded-xl border-2 border-err-line bg-err-soft p-4">
            <div className="text-[13px] font-semibold text-err-ink">⚠ Diferencia: vendido sin facturar</div>
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
          <p className="px-4 text-[12px] text-dim">Calculado desde las líneas de pago: una venta dividida suma a cada medio solo lo aplicado en él.</p>
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

      {/* Cuadre de efectivo: solo lo APLICADO a las ventas (no el billete entregado) */}
      <section className={card}>
        <h2 className="px-4 pt-3 font-semibold">Cuadre de efectivo</h2>
        <p className="px-4 text-[12px] text-dim">Suma solo el efectivo <b>aplicado</b> a las ventas (lo que debe haber en caja), no el billete que entregó el cliente ni el cambio devuelto.</p>
        <table className="w-full text-[14px] mt-2">
          <thead className={head}><tr><th className={th}>Cajero</th><th className={`${th} text-right`}>Ventas con efectivo</th><th className={`${th} text-right`}>Efectivo a cuadrar</th></tr></thead>
          <tbody className="divide-y divide-line">
            {cashByCashier.rows.map((r) => (
              <tr key={r.name}><td className={th}>{r.name}</td><td className={`${th} text-right`}>{r.n}</td><td className={`${th} text-right font-semibold`}>{formatCOP(r.total)}</td></tr>
            ))}
            {!cashByCashier.rows.length && <tr><td colSpan={3} className="px-4 py-6 text-center text-dim">Sin ventas en efectivo en este rango.</td></tr>}
            {cashByCashier.rows.length > 0 && (
              <tr className="font-bold"><td className={th}>Total</td><td className={th} /><td className={`${th} text-right`}>{formatCOP(cashTotal)}</td></tr>
            )}
            {annulledCash > 0 && (
              <>
                <tr><td className={th} colSpan={2}>Efectivo de ventas anuladas con dinero cobrado <span className="text-[12px] text-dim">(el dinero sigue en caja)</span></td><td className={`${th} text-right`}>{formatCOP(annulledCash)}</td></tr>
                <tr className="font-bold bg-subtle"><td className={th} colSpan={2}>Efectivo total esperado en caja</td><td className={`${th} text-right`}>{formatCOP(cashTotal + annulledCash)}</td></tr>
              </>
            )}
          </tbody>
        </table>
      </section>

      {/* Ventas anuladas con dinero cobrado: línea aparte. NO cuentan en "Total recaudado" ni en "Total facturado". */}
      <section className={card}>
        <h2 className="px-4 pt-3 font-semibold">Ventas anuladas con dinero cobrado <span className="text-[13px] font-medium text-dim">· {formatCOP(annulledTotal)} ({annulled.rows.length})</span></h2>
        <p className="px-4 text-[12px] text-dim">El cliente ya pagó pero la venta se anuló (p. ej. precio por revisar). No cuentan en “Total recaudado” ni en “Total facturado”; se muestran aquí para que el efectivo y los medios de pago cuadren.</p>
        {annulled.rows.length === 0 ? (
          <p className="px-4 py-6 text-center text-dim text-[14px]">Sin ventas anuladas con dinero cobrado en este rango.</p>
        ) : (
          <table className="w-full min-w-[640px] text-[14px] mt-2">
            <thead className={head}><tr><th className={th}>Fecha</th><th className={th}>Venta</th><th className={th}>Cajero</th><th className={th}>Nota</th><th className={`${th} text-right`}>Cobrado</th><th className={`${th} text-right`}>Del cual efectivo</th></tr></thead>
            <tbody className="divide-y divide-line">
              {annulled.rows.map((r) => (
                <tr key={r.local_number} className="align-top">
                  <td className={`${th} whitespace-nowrap`}>{r.day}</td>
                  <td className={`${th} whitespace-nowrap`}>{r.local_number}</td>
                  <td className={th}>{r.cashier}</td>
                  <td className={`${th} text-[13px] max-w-xs break-words`}>{r.note ?? "—"}{r.by_name ? <div className="text-[12px] text-dim">por {r.by_name}</div> : null}</td>
                  <td className={`${th} text-right whitespace-nowrap`}>{formatCOP(r.cobrado)}</td>
                  <td className={`${th} text-right whitespace-nowrap`}>{formatCOP(r.efectivo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Ventas a crédito: por cliente, con plazo y vencimiento. NO cuentan como recaudado. */}
      <section className={card}>
        <h2 className="px-4 pt-3 font-semibold">Ventas a crédito (Crédito FECP) <span className="text-[13px] font-medium text-dim">· {formatCOP(creditTotal)}</span></h2>
        <p className="px-4 text-[12px] text-dim">No es dinero recaudado: queda por cobrar en Siigo. El POS no lleva saldos ni abonos.</p>
        {creditByClient.size === 0 ? (
          <p className="px-4 py-6 text-center text-dim text-[14px]">Sin ventas a crédito en este rango.</p>
        ) : (
          <div className="px-4 pb-3 space-y-3 mt-2">
            {[...creditByClient.values()].map((g) => (
              <div key={g.ident} className="rounded-lg border border-line">
                <div className="px-3 py-2 bg-subtle flex items-center justify-between gap-3 text-[14px]">
                  <span className="font-semibold">{g.client} <span className="text-dim font-normal">{g.ident}</span></span>
                  <span className="font-bold">{formatCOP(g.total)}</span>
                </div>
                <table className="w-full text-[13px]">
                  <thead className="text-left text-dim"><tr><th className="px-3 py-1">Fecha</th><th className="px-3 py-1">Venta</th><th className="px-3 py-1">Plazo</th><th className="px-3 py-1">Vence</th><th className="px-3 py-1 text-right">Monto</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {g.rows.map((r) => (
                      <tr key={r.local_number}>
                        <td className="px-3 py-1 whitespace-nowrap">{r.day}</td>
                        <td className="px-3 py-1 whitespace-nowrap">{r.local_number}{r.invoice_name ? ` (${r.invoice_name})` : ""}</td>
                        <td className="px-3 py-1 whitespace-nowrap">{r.credit_days ?? "—"} días</td>
                        <td className="px-3 py-1 whitespace-nowrap font-medium">{r.due ?? "—"}</td>
                        <td className="px-3 py-1 text-right whitespace-nowrap">{formatCOP(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}
      </section>

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
