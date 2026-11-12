import { after, NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { PaymentInputError, processPayment } from "@/lib/epayco/process";
import { writeLog } from "@/lib/log";
import { sourceForRole } from "@/lib/kiosk";
import { isUuid } from "@/lib/sales";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 60;

/**
 * El navegador del kiosco avisa "terminé el pago, este es el ref_payco".
 * El ref_payco es solo una PISTA para buscar: el servidor consulta a ePayco por su cuenta y verifica todo.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  // Solo quien creó el cobro (el kiosco o el cajero) puede confirmarlo
  const own = await query("SELECT 1 FROM sales WHERE id = $1 AND source = $3 AND cashier_id = $2", [id, g.user.uid, sourceForRole(g.user.role)]);
  if (!own.rowCount) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as { ref_payco?: unknown } | null;
  try {
    const r = await processPayment(id, String(body?.ref_payco ?? ""), "kiosco");
    if (r.startInvoicing) {
      // Facturar DESPUÉS de responder: Siigo puede tardar y el kiosco solo necesita saber que el pago quedó confirmado
      after(() => invoiceSale(id, g.user.uid).catch((e) => writeLog("factura", `Error facturando pago electrónico: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: id } })));
    }
    return NextResponse.json({ outcome: r.outcome, status: r.saleStatus, message: r.message });
  } catch (e) {
    if (e instanceof PaymentInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    await writeLog("pago", `Error procesando pago: ${e instanceof Error ? e.message : e}`, { level: "error", userId: g.user.uid, detail: { sale_id: id } });
    return NextResponse.json({ error: "No se pudo verificar el pago. Acérquese a la caja." }, { status: 500 });
  }
}
