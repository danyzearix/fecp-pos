import type { Metadata } from "next";
import { requirePage } from "@/lib/auth";
import { query } from "@/lib/db";
import { priceHistoryHours } from "@/lib/price-check";
import type { ReviewDetail } from "@/lib/price-review-rules";
import PreciosClient, { type DecidedRow, type HeldRow } from "./PreciosClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Precios por revisar" };

export default async function PreciosPorRevisarPage() {
  await requirePage("/admin"); // solo admin (src/lib/permissions.ts)
  const [held, decided] = await Promise.all([
    query<{
      id: string; local_number: string; total: number; cashier: string; sale_time: Date; held_since: Date; held_min: number;
      detail: ReviewDetail; time_note: string | null; methods: string[] | null;
    }>(
      `SELECT s.id, s.local_number, s.total::float8 AS total, u.name AS cashier, COALESCE(s.created_at_device, s.created_at) AS sale_time,
              s.price_review_at AS held_since, (extract(epoch FROM (now() - s.price_review_at)) / 60)::float8 AS held_min,
              s.price_review_detail AS detail, s.time_note,
              (SELECT array_agg(sp.method ORDER BY sp.ord) FROM sale_payments sp WHERE sp.sale_id = s.id) AS methods
         FROM sales s JOIN users u ON u.id = s.cashier_id
        WHERE s.price_review_status = 'pendiente' AND s.status IN ('pending','failed')
        ORDER BY s.price_review_at`
    ),
    query<{ local_number: string; decision: "aprobada" | "anulada"; by_name: string | null; decided_at: Date; note: string | null; total: number; invoice_name: string | null; status: string }>(
      `SELECT s.local_number, s.price_review_status AS decision, ru.name AS by_name, s.price_review_decided_at AS decided_at,
              s.price_review_note AS note, s.total::float8 AS total, s.invoice_name, s.status
         FROM sales s LEFT JOIN users ru ON ru.id = s.price_review_by
        WHERE s.price_review_status IN ('aprobada','anulada')
        ORDER BY s.price_review_decided_at DESC NULLS LAST LIMIT 30`
    ),
  ]);

  const heldRows: HeldRow[] = held.rows.map((r) => ({
    id: r.id, local_number: r.local_number, total: r.total, cashier: r.cashier, sale_time: r.sale_time.toISOString(),
    held_since: r.held_since.toISOString(), held_min: r.held_min, detail: r.detail, time_note: r.time_note, methods: r.methods ?? [],
  }));
  const decidedRows: DecidedRow[] = decided.rows.map((r) => ({ ...r, decided_at: r.decided_at ? r.decided_at.toISOString() : null }));
  return <PreciosClient held={heldRows} decided={decidedRows} windowHours={priceHistoryHours()} />;
}
