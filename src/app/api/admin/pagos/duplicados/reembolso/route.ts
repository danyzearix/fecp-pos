import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";

const REF_RE = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * Pagos duplicados → "Marcar para reembolso" (solo admin). { ref_payco }.
 * Un pago duplicado es un SEGUNDO pago aprobado de una venta que ya estaba pagada: nunca se factura.
 * Esto solo deja CONSTANCIA; el reembolso real se hace en el panel de ePayco.
 */
export async function POST(req: Request) {
  const g = await guardApi(req); // /api/admin/*: solo admin
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => null)) as { ref_payco?: unknown } | null;
  const ref = String(body?.ref_payco ?? "").trim();
  if (!REF_RE.test(ref)) return NextResponse.json({ error: "ref_payco no válido" }, { status: 400 });

  const r = await query<{ local_number: string; amount: number | null }>(
    `UPDATE payment_refs r SET refund_requested_at = now(), refund_requested_by = $2
       FROM sales s
      WHERE r.ref_payco = $1 AND r.outcome = 'duplicado' AND r.refund_requested_at IS NULL AND s.id = r.sale_id
      RETURNING s.local_number, r.amount::float8 AS amount`,
    [ref, g.user.uid]
  );
  if (!r.rows[0]) return NextResponse.json({ error: "Ese pago no es un duplicado pendiente (o ya estaba marcado)" }, { status: 409 });
  await writeLog("pago", `${g.user.name} marcó para reembolso el pago DUPLICADO de ${r.rows[0].local_number} (el reembolso se hace en ePayco)`, {
    userId: g.user.uid,
    detail: { ref_payco: ref, amount: r.rows[0].amount },
  });
  return NextResponse.json({ ok: true });
}
