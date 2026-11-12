import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { getPosConfig } from "@/lib/config";
import { query } from "@/lib/db";
import { getTicketData, isUuid } from "@/lib/sales";

/** Tirilla de UNA venta del propio kiosco, solo cuando ya está facturada (para imprimirla en el kiosco si KIOSCO_IMPRESORA=true). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const own = await query<{ status: string }>("SELECT status FROM sales WHERE id = $1 AND source = 'kiosco' AND cashier_id = $2", [id, g.user.uid]);
  if (!own.rows[0]) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  if (own.rows[0].status !== "invoiced") return NextResponse.json({ error: "La factura aún no está lista" }, { status: 409 });

  const ticket = await getTicketData(id);
  if (!ticket) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  return NextResponse.json({ ticket, config: getPosConfig() }, { headers: { "Cache-Control": "no-store" } });
}
