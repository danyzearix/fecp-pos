import { after, NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { activeCheck, paymentState } from "@/lib/epayco/active";
import { isShortRef } from "@/lib/epayco/adapter";
import { attachRef } from "@/lib/epayco/attempts";
import { expireWaitingPayments, PaymentInputError, processPayment, type PaymentResult } from "@/lib/epayco/process";
import { sourceForRole } from "@/lib/kiosk";
import { writeLog } from "@/lib/log";
import { rateLimited } from "@/lib/rate-limit";
import { isUuid } from "@/lib/sales";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 60;

/** Pausa mínima entre dos consultas a ePayco del MISMO intento (la pantalla pregunta cada 2–3 s; el servidor no consulta de más) */
const MIN_GAP_MS = 2000;

/**
 * La pantalla pregunta "¿cómo va mi pago?" (cada 2–3 s mientras verifica). Responde el estado y el último intento. Además:
 *  - si trae { ref_payco } (pista del navegador) la guarda en el intento y la VERIFICA con ePayco (servidor a servidor);
 *  - si no, y el servidor ya conoce la referencia larga del intento (por el navegador o el webhook), hace la CONSULTA ACTIVA.
 * Todo pasa por processPayment: monto, firma, invoice, modo de prueba, reclamo atómico y una sola factura.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  if (rateLimited(`verificar:${id}`, 90, 60_000)) return NextResponse.json({ error: "Demasiadas consultas" }, { status: 429 });

  const own = await query("SELECT 1 FROM sales WHERE id = $1 AND source = $3 AND cashier_id = $2 AND payment_method = 'epayco'", [id, g.user.uid, sourceForRole(g.user.role)]);
  if (!own.rowCount) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { ref_payco?: unknown } | null;
  const hint = typeof body?.ref_payco === "string" ? body.ref_payco.trim() : "";
  await expireWaitingPayments(id).catch(() => {});
  try {
    let r: PaymentResult | null = null;
    if (hint && /^[A-Za-z0-9_-]{4,64}$/.test(hint) && !isShortRef(hint)) {
      await attachRef(id, hint);
      r = await activeCheck(id, "kiosco", MIN_GAP_MS);
      // Una referencia que no es la del intento (p. ej. pegada a mano por el cajero) se verifica directamente
      if (!r) r = await processPayment(id, hint, "kiosco");
    } else {
      r = await activeCheck(id, "kiosco", MIN_GAP_MS);
    }
    if (r?.startInvoicing) {
      after(() => invoiceSale(id, g.user.uid).catch((e) => writeLog("factura", `Error facturando pago electrónico: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: id } })));
    }
    const st = await paymentState(id);
    return NextResponse.json({ ...st, outcome: r?.outcome ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof PaymentInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    await writeLog("pago", `Error en la verificación activa: ${e instanceof Error ? e.message : e}`, { level: "error", userId: g.user.uid, detail: { sale_id: id } });
    // Aun así se devuelve el estado que hay en nuestra base: la pantalla sigue consultando
    return NextResponse.json({ ...(await paymentState(id)), outcome: "no_verificado" }, { headers: { "Cache-Control": "no-store" } });
  }
}
