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
 * "Intentar de nuevo": abre un INTENTO nuevo de la MISMA venta con el canal que la persona elija ({ channel, replace? }).
 * Cada intento tiene su propia referencia hacia ePayco (K01-000123-2…). El SERVIDOR lo rechaza (409) si la venta ya está pagada,
 * venció, o tiene un intento pendiente/aprobado; si hay un intento abierto sin resultado solo lo reemplaza con replace:true
 * (cambiar de QR a pantalla, o la ventana de ePayco nunca llegó a abrirse).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  if (rateLimited(`intento:${id}`, 15, 10 * 60_000)) return NextResponse.json({ error: "Demasiados intentos para esta compra." }, { status: 429 });

  const source = sourceForRole(g.user.role);
  const own = await query("SELECT 1 FROM sales WHERE id = $1 AND source = $3 AND cashier_id = $2 AND payment_method = 'epayco'", [id, g.user.uid, source]);
  if (!own.rowCount) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { channel?: unknown; replace?: unknown } | null;
  if (!isPayChannel(body?.channel)) return NextResponse.json({ error: "Canal no válido" }, { status: 400 });

  const origin = browserOrigin(req);
  const responseUrl = source === "caja" ? `${origin}/caja` : getEpaycoConfig().responseUrl || `${origin}/kiosco`;
  try {
    const r = await openAttempt({ saleId: id, channel: body.channel, userId: g.user.uid, responseUrl, where: source === "caja" ? "la caja" : "el kiosco", replace: body?.replace === true });
    if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
    return NextResponse.json({ attempt: r.attemptNo, channel: r.channel, session_id: r.sessionId, pay_url: r.payUrl });
  } catch (e) {
    const reason = e instanceof EpaycoError ? `(${e.kind}) ${e.message}` : e instanceof Error ? e.message : String(e);
    await writeLog("pago", `No se pudo abrir un intento de pago: ${reason}`, { level: "error", userId: g.user.uid, detail: { sale_id: id } });
    return NextResponse.json({ error: "No se pudo iniciar el pago. Intente de nuevo." }, { status: 502 });
  }
}
