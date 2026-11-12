import { after, NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { PaymentInputError, processPayment } from "@/lib/epayco/process";
import { writeLog } from "@/lib/log";
import { isUuid } from "@/lib/sales";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 60;

/**
 * Verificar un cobro con su referencia de ePayco (solo admin). Sirve cuando el cliente SÍ pagó pero la pantalla no recibió
 * el ref_payco (se cerró el navegador, se cortó la conexión...). Acepta el enlace "...?ref_payco=..." o la referencia larga.
 * Pasa por el MISMO camino de siempre: el servidor consulta a ePayco y valida monto, factura, moneda, modo de prueba y firma.
 * Si el cobro ya estaba vencido (pago_fallido) y ePayco confirma que se aprobó, queda como 'pago_tardio' para decidir.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req); // /api/admin/*: solo admin
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { ref_payco?: unknown } | null;
  const text = String(body?.ref_payco ?? "").trim();
  const ref = /ref_payco=([A-Za-z0-9_-]{4,64})/.exec(text)?.[1] ?? text;

  const own = await query<{ status: string }>("SELECT status FROM sales WHERE id = $1 AND payment_method = 'epayco'", [id]);
  if (!own.rows[0]) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  if (!["esperando_pago", "pago_fallido"].includes(own.rows[0].status)) {
    return NextResponse.json({ error: `La venta está en estado '${own.rows[0].status}': ya no se puede verificar por referencia` }, { status: 409 });
  }

  try {
    const r = await processPayment(id, ref, "admin");
    await writeLog("pago", `${g.user.name} verificó con referencia el cobro de la venta: ${r.outcome}`, { userId: g.user.uid, detail: { sale_id: id, outcome: r.outcome } });
    if (r.startInvoicing) {
      after(() => invoiceSale(id, g.user.uid).catch((e) => writeLog("factura", `Error facturando pago electrónico: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: id } })));
    }
    return NextResponse.json({ outcome: r.outcome, status: r.saleStatus, message: r.message });
  } catch (e) {
    if (e instanceof PaymentInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    await writeLog("pago", `Error verificando pago por referencia: ${e instanceof Error ? e.message : e}`, { level: "error", userId: g.user.uid, detail: { sale_id: id } });
    return NextResponse.json({ error: "No se pudo verificar el pago" }, { status: 500 });
  }
}
