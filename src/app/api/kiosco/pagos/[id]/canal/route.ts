import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { openAttempt } from "@/lib/epayco/attempts";
import { isPayChannel } from "@/lib/epayco/channel";
import { EpaycoError } from "@/lib/epayco/adapter";
import { getEpaycoConfig } from "@/lib/epayco/config";
import { sourceForRole } from "@/lib/kiosk";
import { writeLog } from "@/lib/log";
import { browserOrigin } from "@/lib/origin";
import { rateLimited } from "@/lib/rate-limit";
import { isUuid } from "@/lib/sales";

export const maxDuration = 60;

/**
 * Cambia el canal de un cobro en curso: { channel: "qr" | "pantalla" }. Solo quien creó el cobro (el kiosco o el cajero).
 * Abre un INTENTO nuevo (con su propia referencia hacia ePayco) y cierra el anterior ('reemplazado'). Con un pago pendiente o
 * aprobado el servidor lo rechaza (409). Con "pantalla" el enlace /pagar deja de servir; con "qr" la pantalla no abre el checkout.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  if (rateLimited(`canal:${id}`, 12, 10 * 60_000)) return NextResponse.json({ error: "Demasiados cambios de canal para este cobro." }, { status: 429 });

  const source = sourceForRole(g.user.role);
  const own = await query("SELECT 1 FROM sales WHERE id = $1 AND source = $3 AND cashier_id = $2 AND payment_method = 'epayco'", [id, g.user.uid, source]);
  if (!own.rowCount) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { channel?: unknown } | null;
  if (!isPayChannel(body?.channel)) return NextResponse.json({ error: "Canal no válido" }, { status: 400 });

  const origin = browserOrigin(req);
  const responseUrl = source === "caja" ? `${origin}/caja` : getEpaycoConfig().responseUrl || `${origin}/kiosco`;
  try {
    const r = await openAttempt({ saleId: id, channel: body.channel, userId: g.user.uid, responseUrl, where: source === "caja" ? "la caja" : "el kiosco", replace: true });
    if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
    return NextResponse.json({ channel: r.channel, session_id: r.sessionId, pay_url: r.payUrl, attempt: r.attemptNo });
  } catch (e) {
    const reason = e instanceof EpaycoError ? `(${e.kind}) ${e.message}` : e instanceof Error ? e.message : String(e);
    await writeLog("pago", `No se pudo cambiar el canal de pago: ${reason}`, { level: "error", userId: g.user.uid, detail: { sale_id: id } });
    return NextResponse.json({ error: "No se pudo cambiar el medio de pago. Intente de nuevo." }, { status: 502 });
  }
}
