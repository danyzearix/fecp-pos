// Contadores de lo que un admin debe resolver (menú de admin, reportes y configuración).
import { query } from "./db";
import { ageLevel, type AgeLevel } from "./price-review-rules";

export type ReviewCounts = {
  /** ventas retenidas por precio por revisar */
  prices: number;
  pricesTotal: number;
  /** minutos que lleva retenida la más antigua */
  pricesOldestMin: number;
  pricesLevel: AgeLevel;
  /** pagos electrónicos por revisar (sin marcar para reembolso) */
  payments: number;
};

export async function reviewCounts(): Promise<ReviewCounts> {
  const [p, pay] = await Promise.all([
    query<{ n: number; total: number; oldest: number | null }>(
      `SELECT count(*)::int AS n, coalesce(sum(total),0)::float8 AS total, max(extract(epoch FROM (now() - price_review_at)) / 60)::float8 AS oldest
         FROM sales WHERE price_review_status = 'pendiente' AND status IN ('pending','failed')`
    ),
    query<{ n: number }>("SELECT count(*)::int AS n FROM sales WHERE status IN ('pago_por_revisar','pago_tardio') AND refund_requested_at IS NULL"),
  ]);
  const oldest = p.rows[0].oldest ?? 0;
  return { prices: p.rows[0].n, pricesTotal: p.rows[0].total, pricesOldestMin: oldest, pricesLevel: p.rows[0].n ? ageLevel(oldest) : "ok", payments: pay.rows[0].n };
}
