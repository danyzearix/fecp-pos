import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { isUuid } from "@/lib/sales";
import { transitionSale, type SaleStatus } from "@/lib/sale-states";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 180;

/**
 * Pagos por revisar → "Facturar" (solo admin). El admin confirma que el dinero SÍ entró en ePayco; la venta pasa a
 * 'pagado' y se factura con el mismo flujo de siempre (reclamo atómico, Idempotency-Key, sin doble factura).
 * Una venta marcada "para reembolso" ya no se puede facturar.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req); // /api/admin/*: solo admin (src/lib/permissions.ts)
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const { rows } = await query<{ status: SaleStatus; local_number: string; refund_requested_at: Date | null }>(
    "SELECT status, local_number, refund_requested_at FROM sales WHERE id = $1 AND payment_method = 'epayco'",
    [id]
  );
  const s = rows[0];
  if (!s) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  if (s.refund_requested_at) return NextResponse.json({ error: "La venta está marcada para reembolso: no se puede facturar" }, { status: 409 });
  if (s.status !== "pago_por_revisar" && s.status !== "pago_tardio") {
    return NextResponse.json({ error: `La venta está en estado '${s.status}': no está pendiente de revisión` }, { status: 409 });
  }

  const moved = await transitionSale(id, [s.status], "pagado", { payment_status: "aprobado" });
  if (!moved) return NextResponse.json({ error: "Otra persona ya resolvió esta venta" }, { status: 409 });
  await writeLog("pago", `${g.user.name} aprobó facturar el pago de ${s.local_number} (estaba ${s.status})`, {
    userId: g.user.uid,
    detail: { sale_id: id, desde: s.status },
  });

  const out = await invoiceSale(id, g.user.uid);
  return NextResponse.json({ ok: true, ...out });
}
