import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { isUuid } from "@/lib/sales";

/**
 * Pagos por revisar → "Marcar para reembolso" (solo admin). Solo deja CONSTANCIA: el reembolso real se hace en el panel
 * de ePayco. La venta no se factura y queda fuera de todos los reportes.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req); // /api/admin/*: solo admin
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const r = await query<{ local_number: string; status: string }>(
    `UPDATE sales SET refund_requested_at = now(), refund_requested_by = $2
      WHERE id = $1 AND payment_method = 'epayco' AND status IN ('pago_por_revisar','pago_tardio') AND refund_requested_at IS NULL
      RETURNING local_number, status`,
    [id, g.user.uid]
  );
  if (!r.rows[0]) return NextResponse.json({ error: "La venta no está pendiente de revisión (o ya estaba marcada)" }, { status: 409 });
  await writeLog("pago", `${g.user.name} marcó para reembolso el pago de ${r.rows[0].local_number} (el reembolso se hace en ePayco)`, {
    userId: g.user.uid,
    detail: { sale_id: id, estado: r.rows[0].status },
  });
  return NextResponse.json({ ok: true });
}
