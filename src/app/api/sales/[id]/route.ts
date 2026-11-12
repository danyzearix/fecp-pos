import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { getPosConfig } from "@/lib/config";
import { getTicketData, isUuid, SALE_DAY_SQL, todayBogota, yesterdayBogota } from "@/lib/sales";

// Datos de una venta para dibujar la tirilla (cualquier usuario autenticado puede reimprimir).
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const user = g.user;

  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  // El cajero solo puede reimprimir sus propias ventas de hoy o ayer
  if (user.role !== "admin") {
    const own = await query<{ cashier_id: number; d1: string; d2: string }>(
      `SELECT s.cashier_id, ${SALE_DAY_SQL}::text AS d1, (s.created_at AT TIME ZONE 'America/Bogota')::date::text AS d2 FROM sales s WHERE s.id = $1`,
      [id]
    );
    const r = own.rows[0];
    const okDays = new Set([todayBogota(), yesterdayBogota()]);
    if (r && (r.cashier_id !== user.uid || (!okDays.has(r.d1) && !okDays.has(r.d2)))) {
      return NextResponse.json({ error: "Solo puedes reimprimir tus ventas de hoy o ayer" }, { status: 403 });
    }
  }

  const ticket = await getTicketData(id);
  if (!ticket) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  return NextResponse.json({ ticket, config: getPosConfig() }, { headers: { "Cache-Control": "no-store" } });
}
