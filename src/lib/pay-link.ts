// Enlace público de pago (/pagar/<código>): quien tenga el código puede pagar ESA venta desde su celular.
// El código es el pay_token (48 hex aleatorios, único). Las páginas y endpoints públicos solo exponen lo mínimo:
// número de compra, total, estado, factura y mensajes seguros (nunca datos del cliente ni detalles técnicos).
import { query } from "./db";
import { expireWaitingPayments } from "./epayco/process";

export const PAY_CODE_RE = /^[0-9a-f]{48}$/;

export type PublicSale = {
  id: string;
  local_number: string;
  status: string;
  payment_status: string | null;
  total: number;
  invoice_name: string | null;
  expires_at: string | null;
  can_pay: boolean;
  /** el cobro sigue abierto pero se pasó a "pagar en pantalla": este enlace ya no sirve */
  channel_changed: boolean;
};

export const CHANNEL_CHANGED_MESSAGE = "Este cobro fue cambiado, pide uno nuevo en caja.";

const MESSAGE: Record<string, string> = {
  esperando_pago: "Esperando su pago…",
  pagado: "Pago recibido. Estamos generando su factura…",
  pending: "Pago recibido. Estamos generando su factura…",
  invoicing: "Pago recibido. Estamos generando su factura…",
  invoiced: "¡Gracias! Su pago fue recibido y su factura quedó generada.",
  failed: "Pago recibido. Su factura se está terminando de procesar; guarde su número de compra.",
  revisar: "Pago recibido. Su factura se está terminando de procesar; guarde su número de compra.",
  pago_fallido: "El pago no se completó.",
  pago_por_revisar: "No pudimos confirmar su pago automáticamente. Comuníquese con la tienda con su número de compra.",
  pago_tardio: "Su pago llegó fuera de tiempo. Comuníquese con la tienda con su número de compra.",
  anulada: "Esta compra fue cancelada.",
};
export const publicMessage = (status: string) => MESSAGE[status] ?? "Procesando…";
/** Mensaje para el cliente según el estado y el canal (si se cambió a "en pantalla", el enlace ya no sirve). */
export const publicMessageFor = (s: Pick<PublicSale, "status" | "channel_changed">) => (s.channel_changed ? CHANNEL_CHANGED_MESSAGE : publicMessage(s.status));

/**
 * Busca la venta por su código. Solo ventas de pago electrónico. Vence los cobros que ya pasaron de tiempo.
 * Solo se puede pagar por aquí si el canal activo del cobro es QR (un cobro nunca tiene los dos canales abiertos).
 */
export async function findPublicSale(code: string): Promise<PublicSale | null> {
  if (!PAY_CODE_RE.test(code)) return null;
  const first = await query<{ id: string }>("SELECT id FROM sales WHERE pay_token = $1 AND payment_method = 'epayco'", [code]);
  if (!first.rows[0]) return null;
  await expireWaitingPayments(first.rows[0].id).catch(() => {});
  const { rows } = await query<{
    id: string; local_number: string; status: string; payment_status: string | null; total: number; invoice_name: string | null; payment_expires_at: Date | null;
    pay_channel: string | null;
  }>(
    "SELECT id, local_number, status, payment_status, total::float8 AS total, invoice_name, payment_expires_at, pay_channel FROM sales WHERE id = $1",
    [first.rows[0].id]
  );
  const s = rows[0];
  if (!s) return null;
  const exp = s.payment_expires_at;
  return {
    id: s.id,
    local_number: s.local_number,
    status: s.status,
    payment_status: s.payment_status,
    total: s.total,
    invoice_name: s.invoice_name,
    expires_at: exp?.toISOString() ?? null,
    can_pay: s.status === "esperando_pago" && !!exp && exp.getTime() > Date.now() && s.pay_channel === "qr",
    channel_changed: s.status === "esperando_pago" && s.pay_channel !== "qr",
  };
}
