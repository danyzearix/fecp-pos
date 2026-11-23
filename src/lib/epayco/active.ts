// CONSULTA ACTIVA del servidor a ePayco: no depender solo del webhook ni de lo que mande el navegador.
// Usa EXACTAMENTE el mismo camino de verificación (processPayment: consulta a ePayco, monto, firma, invoice, modo de prueba,
// reclamo atómico del ref_payco, una sola factura). Aquí solo se decide CUÁNDO consultar y con qué referencia.
//
// ⚠ LÍMITE de la API de ePayco: lo ÚNICO documentado es consultar por la referencia LARGA (ref_payco, la de ?ref_payco=...). No hay consulta
// documentada por invoice, sessionId, x_transaction_id ni x_ref_payco. El webhook de PSE llega SIN ref_payco (solo x_ref_payco corta y
// x_transaction_id), así que además de la larga se PRUEBAN esas dos, en orden (ver candidates.ts). Si ninguna sirve, no hay forma de
// preguntar: se espera la referencia larga (navegador o panel del admin) y, si el cobro vence, queda como siempre (pago_tardio).
import { query } from "../db";
import { writeLog } from "../log";
import { candidatesOf, latestAttemptView, type Attempt, type AttemptView } from "./attempts";
import { triedText, verifyByCandidates } from "./candidates";
import { getEpaycoConfig } from "./config";
import type { PaymentResult } from "./process";

/** Sin referencia larga (solo lo que trajo el webhook: x_transaction_id / x_ref_payco) la consulta es una PRUEBA: no se repite más seguido que esto */
const MIN_GAP_WITHOUT_LONG_MS = 15_000;

/**
 * Consulta a ePayco el intento abierto/pendiente de la venta que ya tenga alguna referencia: la larga (ref_payco) o, si solo llegó el
 * webhook (PSE), el x_transaction_id y la x_ref_payco. Usa la MISMA lista y el mismo orden que el webhook (candidatesOf), y la que ya
 * funcionó va primero. `minGapMs` limita la frecuencia POR INTENTO (un UPDATE atómico reclama el turno).
 * Devuelve null si no había nada que consultar (sin referencia, o aún no toca).
 */
export async function activeCheck(saleId: string, source: "kiosco" | "poller" | "publica", minGapMs: number): Promise<PaymentResult | null> {
  const claim = await query<Pick<Attempt, "invoice" | "ref_payco" | "x_transaction_id" | "x_ref_payco" | "ref_used" | "checks">>(
    `UPDATE payment_attempts SET last_check_at = now(), checks = checks + 1
      WHERE id = (SELECT id FROM payment_attempts
                   WHERE sale_id = $1 AND status IN ('abierto','pendiente')
                     AND (ref_payco IS NOT NULL OR ($4::boolean AND (x_transaction_id IS NOT NULL OR x_ref_payco IS NOT NULL)))
                   ORDER BY attempt_no DESC LIMIT 1)
        AND (last_check_at IS NULL OR last_check_at < now() - ((CASE WHEN ref_payco IS NULL THEN GREATEST($2::int, $3::int) ELSE $2::int END) || ' milliseconds')::interval)
      RETURNING invoice, ref_payco, x_transaction_id, x_ref_payco, ref_used, checks`,
    [saleId, Math.max(0, Math.floor(minGapMs)), MIN_GAP_WITHOUT_LONG_MS, getEpaycoConfig().altRefLookup]
  );
  const a = claim.rows[0];
  if (!a) return null;
  const cands = candidatesOf(a);
  const run = await verifyByCandidates(saleId, cands, source);
  if (!run) return null;
  // Se anota lo probado cuando NINGUNA referencia sirvió (la 1.ª, 2.ª, 3.ª vez y luego cada 10.ª)
  if (run.outcome === "no_verificado" && cands.some((c) => c.kind !== "larga") && (a.checks <= 3 || a.checks % 10 === 0)) {
    await writeLog("pago", `Consulta activa de ${a.invoice} (consulta ${a.checks}): ePayco no devolvió la transacción con ninguna referencia conocida — ${triedText(run.tried)}`, {
      level: "warn", detail: { sale_id: saleId, invoice: a.invoice, source, tried: run.tried },
    });
  }
  return run;
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
