// CONSULTA ACTIVA del servidor a ePayco: no depender solo del webhook ni de lo que mande el navegador.
// Usa EXACTAMENTE el mismo camino de verificación (processPayment: consulta a ePayco, monto, firma, invoice, modo de prueba,
// reclamo atómico del ref_payco, una sola factura). Aquí solo se decide CUÁNDO consultar y con qué referencia.
//
// ⚠ LÍMITE de la API de ePayco: la consulta solo funciona por la referencia LARGA (ref_payco). La documentación oficial no
// publica consulta por invoice ni por sessionId. Por eso la consulta activa solo se puede hacer cuando el servidor YA conoce la
// referencia larga del intento (la trae el navegador desde los hooks / la URL de regreso, o el webhook). Si nunca llegó ninguna,
// no hay forma de preguntar: se espera el webhook y, si el cobro vence, queda como siempre (pago_tardio si luego se aprueba).
import { query } from "../db";
import { isShortRef } from "./adapter";
import { latestAttemptView, type AttemptView } from "./attempts";
import { processPayment, type PaymentResult } from "./process";

/**
 * Consulta a ePayco el intento abierto/pendiente de la venta que ya tenga referencia larga. `minGapMs` limita la frecuencia POR
 * INTENTO (un UPDATE atómico reclama el turno: varios procesos o pantallas a la vez no consultan de más).
 * Devuelve null si no había nada que consultar (sin referencia, o aún no toca).
 */
export async function activeCheck(saleId: string, source: "kiosco" | "poller" | "publica", minGapMs: number): Promise<PaymentResult | null> {
  const claim = await query<{ ref_payco: string }>(
    `UPDATE payment_attempts SET last_check_at = now(), checks = checks + 1
      WHERE id = (SELECT id FROM payment_attempts WHERE sale_id = $1 AND status IN ('abierto','pendiente') AND ref_payco IS NOT NULL
                  ORDER BY attempt_no DESC LIMIT 1)
        AND (last_check_at IS NULL OR last_check_at < now() - ($2 || ' milliseconds')::interval)
      RETURNING ref_payco`,
    [saleId, String(Math.max(0, Math.floor(minGapMs)))]
  );
  const ref = claim.rows[0]?.ref_payco;
  if (!ref || isShortRef(ref)) return null;
  return processPayment(saleId, ref, source);
}

export type PaymentState = {
  status: string;
  payment_status: string | null;
  local_number: string;
  total: number;
  invoice_name: string | null;
  expires_at: string | null;
  /** último intento de pago: la pantalla decide con esto qué mostrar (cancelado / rechazado / pendiente / abierto…) */
  attempt: AttemptView;
};

export async function paymentState(saleId: string): Promise<PaymentState | null> {
  const r = (
    await query<{ status: string; payment_status: string | null; local_number: string; total: number; invoice_name: string | null; exp: Date | null }>(
      "SELECT status, payment_status, local_number, total::float8 AS total, invoice_name, payment_expires_at AS exp FROM sales WHERE id = $1",
      [saleId]
    )
  ).rows[0];
  if (!r) return null;
  return {
    status: r.status,
    payment_status: r.payment_status,
    local_number: r.local_number,
    total: r.total,
    invoice_name: r.invoice_name,
    expires_at: r.exp?.toISOString() ?? null,
    attempt: await latestAttemptView(saleId),
  };
}
