import { requirePage } from "@/lib/auth";
import { query } from "@/lib/db";
import PagosClient, { type PagoRow } from "./PagosClient";

export const dynamic = "force-dynamic";

const SELECT = `
  SELECT s.id, s.local_number, s.status, s.source, s.total::float8 AS total, s.created_at, s.payment_failure_reason,
         s.epayco_ref, s.payment_reference, s.notify_email, s.refund_requested_at,
         c.identification AS customer_id,
         COALESCE(NULLIF(c.company_name,''), NULLIF(trim(c.first_name || ' ' || c.last_name),'')) AS customer_name,
         u.name AS cashier, ru.name AS refund_by,
         (SELECT COALESCE(json_agg(json_build_object('ref', r.ref_payco, 'outcome', r.outcome, 'reason', r.reason) ORDER BY r.started_at), '[]'::json)
            FROM payment_refs r WHERE r.sale_id = s.id) AS refs
    FROM sales s
    JOIN users u ON u.id = s.cashier_id
    LEFT JOIN users ru ON ru.id = s.refund_requested_by
    LEFT JOIN customers c ON c.id = s.customer_id
   WHERE s.payment_method = 'epayco'`;

const toRow = (r: Record<string, unknown>): PagoRow => ({ ...(r as unknown as PagoRow), created_at: new Date(r.created_at as string).toISOString(), refund_requested_at: r.refund_requested_at ? new Date(r.refund_requested_at as string).toISOString() : null });

export default async function PagosPorRevisarPage() {
  await requirePage("/admin");
  const [review, unconfirmed, refunds] = await Promise.all([
    // Pagos que un admin debe resolver (todas las fechas)
    query(`${SELECT} AND s.status IN ('pago_por_revisar','pago_tardio') AND s.refund_requested_at IS NULL ORDER BY s.created_at DESC`),
    // Cobros que no se confirmaron: por si el cliente SÍ pagó pero la pantalla no recibió la referencia (últimos 7 días)
    query(`${SELECT} AND s.status IN ('esperando_pago','pago_fallido') AND s.refund_requested_at IS NULL AND s.created_at > now() - interval '7 days' ORDER BY s.created_at DESC LIMIT 100`),
    query(`${SELECT} AND s.refund_requested_at IS NOT NULL ORDER BY s.refund_requested_at DESC LIMIT 50`),
  ]);
  return (
    <PagosClient
      review={review.rows.map(toRow)}
      unconfirmed={unconfirmed.rows.map(toRow)}
      refunds={refunds.rows.map(toRow)}
    />
  );
}
