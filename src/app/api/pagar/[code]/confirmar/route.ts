import { after, NextResponse } from "next/server";
import { PaymentInputError, processPayment } from "@/lib/epayco/process";
import { writeLog } from "@/lib/log";
import { findPublicSale } from "@/lib/pay-link";
import { rateLimited } from "@/lib/rate-limit";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 60;

/**
 * PÚBLICO (sin sesión). El navegador del cliente avisa "terminé de pagar, este es el ref_payco". Es solo una PISTA: el servidor
 * consulta a ePayco por su cuenta y valida monto, factura, moneda, modo de prueba y firma. Nunca se confía en el navegador.
 * Cada ref_payco se procesa una sola vez y una venta admite pocas referencias.
 */
export async function POST(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (rateLimited(`pagar:confirmar:${code.slice(0, 12)}`, 90, 10 * 60_000)) return NextResponse.json({ error: "Demasiados intentos. Espere unos minutos." }, { status: 429 });
  const s = await findPublicSale(code);
  if (!s) return NextResponse.json({ error: "Enlace no válido" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { ref_payco?: unknown } | null;
  try {
    const r = await processPayment(s.id, String(body?.ref_payco ?? ""), "publica");
    if (r.startInvoicing) {
      after(() => invoiceSale(s.id).catch((e) => writeLog("factura", `Error facturando pago electrónico: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: s.id } })));
    }
    return NextResponse.json({ outcome: r.outcome, status: r.saleStatus, message: r.message });
  } catch (e) {
    if (e instanceof PaymentInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    await writeLog("pago", `Error procesando pago por enlace: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: s.id } });
    return NextResponse.json({ error: "No se pudo verificar el pago. Comuníquese con la tienda." }, { status: 500 });
  }
}
