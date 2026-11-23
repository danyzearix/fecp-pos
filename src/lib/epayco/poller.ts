// Consulta activa periódica (en el servidor): mientras una venta esté 'esperando_pago' y su cobro siga vigente, cada
// EPAYCO_POLL_SECONDS (20 por defecto) se le pregunta a ePayco por su cuenta por los intentos que ya tienen referencia larga.
// Así un webhook retrasado (o que nunca llegue) no deja una venta pagada sin facturar. Cubre también la ruta del QR.
// Es idempotente: usa processPayment (reclamo atómico del ref_payco) y la facturación de siempre (una sola factura).
import { query } from "../db";
import { cancelSale } from "./attempts";
import { expireWaitingPayments } from "./process";
import { writeLog } from "../log";
import { invoiceSale } from "../siigo/invoice";
import { activeCheck } from "./active";
import { getEpaycoConfig } from "./config";

const g = globalThis as unknown as { __payPollBusy?: boolean };

/** Una venta cuyo último intento terminó mal (rechazado/cancelado) y nadie volvió a elegir en este tiempo se considera abandonada y se cancela. */
export const ABANDON_MINUTES = 5;

export async function pollWaitingPayments(): Promise<number> {
  const secs = getEpaycoConfig().pollSeconds;
  if (!secs || g.__payPollBusy) return 0;
  g.__payPollBusy = true;
  let n = 0;
  try {
    // Los cobros vencidos se cierran aunque nadie pregunte por ellos (antes solo se vencían al consultar su estado)
    await expireWaitingPayments().catch(() => {});
    // Abandonados: rechazo o cancelación sin un intento nuevo → cancelada (no queda abierta hasta que venza)
    const abandoned = await query<{ id: string }>(
      `SELECT s.id FROM sales s
        WHERE s.status = 'esperando_pago' AND s.payment_method = 'epayco'
          AND NOT EXISTS (SELECT 1 FROM payment_attempts a WHERE a.sale_id = s.id AND a.status NOT IN ('rechazado','cancelado','vencido'))
          AND EXISTS (SELECT 1 FROM payment_attempts a WHERE a.sale_id = s.id)
          AND (SELECT max(coalesce(a.closed_at, a.created_at)) FROM payment_attempts a WHERE a.sale_id = s.id) < now() - ($1 || ' minutes')::interval`,
      [String(ABANDON_MINUTES)]
    );
    for (const r of abandoned.rows) await cancelSale(r.id, "abandonada tras un pago rechazado o cancelado").catch(() => {});
    // Con intento vivo: ventas esperando, y las que quedaron "por revisar" por inactividad mientras el cobro siga vigente
    const rows = await query<{ sale_id: string }>(
      `SELECT DISTINCT a.sale_id FROM payment_attempts a JOIN sales s ON s.id = a.sale_id
        WHERE s.status IN ('esperando_pago','pago_por_revisar') AND s.payment_expires_at > now() AND a.status IN ('abierto','pendiente') AND a.ref_payco IS NOT NULL`
    );
    for (const r of rows.rows) {
      try {
        const res = await activeCheck(r.sale_id, "poller", Math.max(1000, (secs - 1) * 1000));
        if (!res) continue;
        n++;
        if (res.startInvoicing) await invoiceSale(r.sale_id).catch((e) => writeLog("factura", `Error facturando pago electrónico (consulta activa): ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: r.sale_id } }));
      } catch (e) {
        await writeLog("pago", `Consulta activa de un cobro falló: ${e instanceof Error ? e.message : e}`, { level: "warn", detail: { sale_id: r.sale_id } });
      }
    }
  } finally {
    g.__payPollBusy = false;
  }
  return n;
}
