import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { EpaycoError } from "@/lib/epayco/adapter";
import { epaycoMissingEnv, getEpaycoConfig } from "@/lib/epayco/config";
import { createSaleSession } from "@/lib/epayco/session";
import { writeLog } from "@/lib/log";
import { browserOrigin } from "@/lib/origin";
import { CHANNEL_CHANGED_MESSAGE, findPublicSale } from "@/lib/pay-link";
import { rateLimited } from "@/lib/rate-limit";
import { epaycoInvoicingBlocker } from "@/lib/siigo/payment";

export const maxDuration = 60;

/**
 * PÚBLICO (sin sesión). Crea una sesión de ePayco para pagar esta venta desde el celular; vuelve a /pagar/<código>/respuesta.
 * El monto sale de NUESTRA base de datos. Solo si la venta sigue 'esperando_pago', no ha vencido y su canal activo es QR.
 */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (rateLimited(`pagar:sesion:${code.slice(0, 12)}`, 10, 10 * 60_000)) return NextResponse.json({ error: "Demasiados intentos. Espere unos minutos." }, { status: 429 });
  const s = await findPublicSale(code);
  if (!s) return NextResponse.json({ error: "Enlace no válido" }, { status: 404 });
  // El enlace solo sirve mientras el canal activo del cobro sea QR (validado aquí, en el servidor)
  if (s.channel_changed) return NextResponse.json({ error: CHANNEL_CHANGED_MESSAGE }, { status: 409 });
  if (!s.can_pay) return NextResponse.json({ error: "Esta compra ya no admite pago desde este enlace" }, { status: 409 });

  if (epaycoMissingEnv().length || epaycoInvoicingBlocker()) {
    await writeLog("pago", `Pago por enlace no disponible para ${s.local_number}: configuración incompleta`, { level: "error", detail: { sale_id: s.id } });
    return NextResponse.json({ error: "El pago electrónico no está disponible. Comuníquese con la tienda." }, { status: 503 });
  }

  const cfg = getEpaycoConfig();
  const base = cfg.publicBaseUrl || browserOrigin(req);
  try {
    const { sessionId, responseUrl } = await createSaleSession({
      saleId: s.id, localNumber: s.local_number, total: s.total, wantedUrl: `${base}/pagar/${code}/respuesta`, where: "la página de pago",
    });
    await query("UPDATE sales SET epayco_session_id = $2 WHERE id = $1 AND status = 'esperando_pago'", [s.id, sessionId]);
    await writeLog("pago", `Sesión de pago por enlace creada para ${s.local_number}`, { detail: { sale_id: s.id, session_id: sessionId, response_url: responseUrl, test: cfg.testMode } });
    return NextResponse.json({ session_id: sessionId, test: cfg.testMode });
  } catch (e) {
    const reason = e instanceof EpaycoError ? `(${e.kind}) ${e.message}` : e instanceof Error ? e.message : String(e);
    await writeLog("pago", `No se pudo crear la sesión de pago por enlace de ${s.local_number}: ${reason}`, { level: "error", detail: { sale_id: s.id } });
    return NextResponse.json({ error: "No se pudo iniciar el pago. Intente de nuevo." }, { status: 502 });
  }
}
