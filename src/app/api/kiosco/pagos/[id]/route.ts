import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { expireWaitingPayments } from "@/lib/epayco/process";
import { sourceForRole } from "@/lib/kiosk";
import { isUuid } from "@/lib/sales";

// Mensajes seguros para el cliente: nunca se devuelve last_error ni detalles técnicos.
const MESSAGE: Record<string, string> = {
  esperando_pago: "Esperando su pago…",
  pagado: "Pago recibido. Generando su factura…",
  pending: "Pago recibido. Generando su factura…",
  invoicing: "Pago recibido. Generando su factura…",
  invoiced: "¡Listo! Su factura fue generada.",
  failed: "Pago recibido. Su factura se está terminando de procesar; guarde su número de compra.",
  revisar: "Pago recibido. Su factura se está terminando de procesar; guarde su número de compra.",
  pago_fallido: "El pago no se completó.",
  pago_por_revisar: "No pudimos confirmar su pago automáticamente. Acérquese a la caja con su número de compra.",
  pago_tardio: "Su pago llegó fuera de tiempo. Acérquese a la caja con su número de compra.",
};

/** Estado de un cobro del kiosco (el kiosco lo consulta cada 3 s; solo lee NUESTRA base de datos). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  await expireWaitingPayments(id).catch(() => {});
  const { rows } = await query<{
    local_number: string; status: string; payment_status: string | null; invoice_name: string | null;
    total: number; payment_expires_at: Date | null; notify_email: string | null;
  }>(
    `SELECT local_number, status, payment_status, invoice_name, total::float8 AS total, payment_expires_at, notify_email
       FROM sales WHERE id = $1 AND source = $3 AND cashier_id = $2`,
    [id, g.user.uid, sourceForRole(g.user.role)]
  );
  const s = rows[0];
  if (!s) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  return NextResponse.json(
    {
      status: s.status,
      payment_status: s.payment_status,
      local_number: s.local_number,
      total: s.total,
      invoice_name: s.invoice_name,
      expires_at: s.payment_expires_at?.toISOString() ?? null,
      message: MESSAGE[s.status] ?? "Procesando…",
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
