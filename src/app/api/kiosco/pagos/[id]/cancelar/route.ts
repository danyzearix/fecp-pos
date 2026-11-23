import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { cancelSale } from "@/lib/epayco/attempts";
import { sourceForRole } from "@/lib/kiosk";
import { isUuid } from "@/lib/sales";

/**
 * "Cancelar compra". Idempotente. Con un pago PENDIENTE (p. ej. PSE) la venta NO se pierde: queda en pago_por_revisar para que un
 * administrador la vea (y si el pago se aprueba, decide Facturar). Sin pendiente queda cancelada (pago_fallido: "cancelada por el cliente").
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const own = await query("SELECT 1 FROM sales WHERE id = $1 AND source = $3 AND cashier_id = $2 AND payment_method = 'epayco'", [id, g.user.uid, sourceForRole(g.user.role)]);
  if (!own.rowCount) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  // { keep: true } = el kiosco se reinició por inactividad con el pago en proceso o sin confirmar: la venta queda para REVISIÓN
  // (no se pierde) y sus intentos se conservan para que la consulta activa los siga verificando
  const body = (await req.json().catch(() => null)) as { keep?: unknown } | null;
  const r = await cancelSale(id, g.user.role === "cliente" ? "el cliente, en el kiosco" : `${g.user.name}, en la caja`, { keepForReview: body?.keep === true });
  return NextResponse.json({ status: r.status, kept_for_review: r.kept_for_review });
}
