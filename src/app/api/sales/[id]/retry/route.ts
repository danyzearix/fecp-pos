import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { isUuid } from "@/lib/sales";
import { invoiceSale, reconcileSale } from "@/lib/siigo/invoice";

export const maxDuration = 180;

/**
 * Reintento manual (el botón llega en /ventas, etapa 5).
 *  - 'failed' o 'pending' → (vuelve a) facturar.
 *  - 'revisar' → SOLO verifica en Siigo (busca el UUID). Si no existe, queda 'failed' y se puede reintentar.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req); // solo admin (src/lib/permissions.ts)
  if (!g.ok) return g.res;
  const user = g.user;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const { rows } = await query<{ status: string; held: boolean }>("SELECT status, price_review_status = 'pendiente' AS held FROM sales WHERE id = $1", [id]);
  const status = rows[0]?.status;
  if (!status) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  // Retenida por precio por revisar: solo se factura desde el panel de admin, tras aprobarla
  if (rows[0].held) {
    return NextResponse.json({ error: "Esta venta está retenida por precio por revisar: decídela en Admin → Precios por revisar (Aprobar y facturar o Anular)." }, { status: 409 });
  }

  // 'pending': registrada pero nunca facturada (p. ej. ventas anteriores a la etapa 4 o un corte del servidor)
  // 'pagado': el pago electrónico ya está verificado pero la facturación no arrancó (p. ej. faltaba configuración)
  if (status === "failed" || status === "pending" || status === "pagado") {
    return NextResponse.json({ ok: true, action: "facturar", ...(await invoiceSale(id, user.uid)) });
  }
  if (status === "revisar") return NextResponse.json({ ok: true, action: "verificar", ...(await reconcileSale(id, user.uid)) });
  return NextResponse.json({ error: `La venta está en estado '${status}': no se puede reintentar` }, { status: 409 });
}
