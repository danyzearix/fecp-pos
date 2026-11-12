// Procesa el pago de una venta del kiosco a partir de un ref_payco. Reglas:
//  - Cada ref_payco se procesa UNA sola vez (INSERT en payment_refs = reclamo atómico).
//  - El servidor consulta a ePayco por su cuenta; nada que mande el navegador cuenta como prueba de pago.
//  - Solo un veredicto 'approved' marca la venta como 'pagado'. Fallas, formatos raros o datos que no coinciden
//    la dejan en 'pago_por_revisar'. Un pago aprobado DESPUÉS de vencer el cobro queda en 'pago_tardio'.
//  - Nunca factura aquí: devuelve startInvoicing y quien llama arranca la facturación (etapa 4).
import { pool, query } from "../db";
import { writeLog } from "../log";
import { transitionAllowed, transitionSale, type SaleStatus } from "../sale-states";
import { EpaycoError, fetchTransaction, type NormalizedTx } from "./adapter";
import { getEpaycoConfig } from "./config";
import { judgeTransaction } from "./verify";

export class PaymentInputError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type PaymentOutcome = "pagado" | "pendiente" | "rechazado" | "por_revisar" | "tardio" | "duplicado" | "en_proceso" | "ya_procesado";
export type PaymentResult = {
  outcome: PaymentOutcome;
  saleStatus: string;
  /** Mensaje seguro para mostrar al cliente en el kiosco (sin detalles internos) */
  message: string;
  startInvoicing: boolean;
};

const REF_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_REFS_PER_SALE = 5;

type SaleRow = { id: string; local_number: string; total: number; status: SaleStatus; source: string; payment_method: string };

async function loadSale(id: string): Promise<SaleRow | null> {
  const { rows } = await query<SaleRow>(
    "SELECT id, local_number, total::float8 AS total, status, source, payment_method FROM sales WHERE id = $1",
    [id]
  );
  return rows[0] ?? null;
}

const customerMessage = (o: PaymentOutcome, local: string): string => {
  switch (o) {
    case "pagado":
      return "Pago recibido. Estamos generando su factura.";
    case "pendiente":
      return "Su pago está pendiente de confirmación. Espere un momento.";
    case "rechazado":
      return "El pago fue rechazado. Puede intentarlo de nuevo.";
    case "por_revisar":
    case "tardio":
    case "duplicado":
      return `No pudimos confirmar su pago automáticamente. Acérquese a la caja con este número: ${local}.`;
    case "en_proceso":
      return "Estamos verificando su pago. Espere un momento.";
    default:
      return "Este pago ya fue procesado.";
  }
};

const detailOf = (tx: NormalizedTx) => ({
  // Sin firma ni llaves
  x_ref_payco: tx.refPayco,
  transaction_id: tx.transactionId,
  invoice: tx.invoice,
  amount: tx.amount,
  currency: tx.currency,
  cod_response: tx.codResponse,
  response: tx.response,
  test_request: tx.testRequest,
  approval_code: tx.approvalCode,
  franchise: tx.franchise,
});

const result = async (saleId: string, outcome: PaymentOutcome, local: string, startInvoicing = false): Promise<PaymentResult> => {
  const s = await loadSale(saleId);
  return { outcome, saleStatus: s?.status ?? "desconocido", message: customerMessage(outcome, local), startInvoicing };
};

const FROM_REF: Record<string, PaymentOutcome> = {
  aprobado: "pagado",
  rechazado: "rechazado",
  por_revisar: "por_revisar",
  tardio: "tardio",
  duplicado: "duplicado",
};

/**
 * Cierra el ref_payco y mueve la venta en UNA transacción de base de datos (o ambos cambios o ninguno).
 * `approved` decide el destino según el estado actual de la venta (con la fila bloqueada).
 */
async function settle(p: {
  saleId: string;
  ref: string;
  kind: "approved" | "rejected" | "review";
  reason: string;
  tx?: NormalizedTx;
  amount?: number;
}): Promise<PaymentOutcome> {
  const c = await pool.connect();
  const exec = (t: string, v: unknown[]) => c.query(t, v);
  try {
    await c.query("BEGIN");
    const cur = (await c.query<{ status: SaleStatus }>("SELECT status FROM sales WHERE id = $1 FOR UPDATE", [p.saleId])).rows[0]?.status;
    let outcome: PaymentOutcome;
    let refOutcome: string;

    if (p.kind === "approved") {
      if (cur === "esperando_pago") {
        await transitionSale(
          p.saleId, ["esperando_pago"], "pagado",
          {
            payment_status: "aprobado", payment_failure_reason: null, last_error: null,
            // epayco_ref = id LARGO (con el que se consulta); payment_reference = número CORTO que ve el cliente y el panel de ePayco
            epayco_ref: p.ref, epayco_transaction_id: p.tx?.transactionId ?? null, payment_reference: p.tx?.refPayco ?? p.ref,
          },
          exec
        );
        outcome = "pagado"; refOutcome = "aprobado";
      } else if (cur === "pago_fallido") {
        await transitionSale(
          p.saleId, ["pago_fallido"], "pago_tardio",
          {
            payment_status: "tardio", epayco_ref: p.ref, epayco_transaction_id: p.tx?.transactionId ?? null,
            payment_failure_reason: "El pago se aprobó DESPUÉS de vencer el cobro. Un administrador debe decidir (facturar o reembolsar).",
          },
          exec
        );
        outcome = "tardio"; refOutcome = "tardio";
      } else {
        // La venta ya está pagada/facturada/en revisión/anulada: este es un SEGUNDO pago. No se toca la venta.
        outcome = "duplicado"; refOutcome = "duplicado";
      }
    } else if (p.kind === "rejected") {
      if (cur === "esperando_pago") {
        await transitionSale(p.saleId, ["esperando_pago"], "pago_fallido", { payment_status: "rechazado", payment_failure_reason: p.reason }, exec);
      }
      outcome = "rechazado"; refOutcome = "rechazado";
    } else {
      if (cur === "esperando_pago") {
        await transitionSale(p.saleId, ["esperando_pago"], "pago_por_revisar", { payment_status: "por_revisar", payment_failure_reason: p.reason, epayco_ref: p.ref }, exec);
      }
      outcome = "por_revisar"; refOutcome = "por_revisar";
    }

    await c.query(
      `UPDATE payment_refs SET outcome = $2, reason = $3, amount = $4, detail = $5, finished_at = now() WHERE ref_payco = $1`,
      [p.ref, refOutcome, p.reason, p.amount ?? p.tx?.amount ?? null, p.tx ? JSON.stringify(detailOf(p.tx)) : null]
    );
    await c.query("COMMIT");
    return outcome;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Quién pide verificar: la pantalla de caja/kiosco, el webhook de ePayco, la página pública /pagar o un admin con la referencia a mano. */
export type PaymentCheckSource = "kiosco" | "webhook" | "publica" | "admin";

export async function processPayment(saleId: string, refRaw: string, source: PaymentCheckSource): Promise<PaymentResult> {
  const ref = String(refRaw ?? "").trim();
  if (!REF_RE.test(ref)) throw new PaymentInputError(400, "ref_payco no válido");

  const sale = await loadSale(saleId);
  // Cobros electrónicos: del kiosco o de la caja (los dos nacen en 'esperando_pago' y se verifican igual con ePayco)
  if (!sale || !["kiosco", "caja"].includes(sale.source) || sale.payment_method !== "epayco") throw new PaymentInputError(404, "Venta no encontrada");

  // ---- Reclamo atómico del ref_payco: se procesa una sola vez ----
  const claimed = await query<{ ref_payco: string }>(
    `INSERT INTO payment_refs (ref_payco, sale_id, outcome, source) VALUES ($1,$2,'procesando',$3)
     ON CONFLICT (ref_payco) DO NOTHING RETURNING ref_payco`,
    [ref, saleId, source]
  );
  if (!claimed.rowCount) {
    const ex = (await query<{ sale_id: string; outcome: string }>("SELECT sale_id, outcome FROM payment_refs WHERE ref_payco = $1", [ref])).rows[0];
    if (!ex || ex.sale_id !== saleId) {
      await writeLog("pago", `ref_payco ya usado por otra venta (intento sobre ${sale.local_number})`, { level: "error", detail: { sale_id: saleId, source } });
      return result(saleId, "ya_procesado", sale.local_number);
    }
    if (ex.outcome === "procesando") {
      // Si quedó "procesando" por una caída del servidor (más de 2 min), se puede retomar; si no, otro proceso lo está atendiendo
      const re = await query(
        "UPDATE payment_refs SET started_at = now() WHERE ref_payco = $1 AND outcome = 'procesando' AND started_at < now() - interval '2 minutes'",
        [ref]
      );
      if (!re.rowCount) return result(saleId, "en_proceso", sale.local_number);
    } else {
      return result(saleId, FROM_REF[ex.outcome] ?? "ya_procesado", sale.local_number);
    }
  } else {
    const n = await query<{ n: number }>("SELECT count(*)::int AS n FROM payment_refs WHERE sale_id = $1", [saleId]);
    if (n.rows[0].n > MAX_REFS_PER_SALE) {
      await query("DELETE FROM payment_refs WHERE ref_payco = $1 AND outcome = 'procesando'", [ref]);
      throw new PaymentInputError(429, "Demasiados intentos para esta venta");
    }
  }

  await writeLog("pago", `Verificando pago de ${sale.local_number} (origen: ${source})`, { detail: { sale_id: saleId, ref_payco: ref, source } });

  // ---- Consultar a ePayco (adaptador) y juzgar ----
  let tx: NormalizedTx | null = null;
  let verdict;
  try {
    tx = await fetchTransaction(ref);
    verdict = judgeTransaction(tx, { local_number: sale.local_number, total: sale.total }, { saleId, testMode: getEpaycoConfig().testMode });
  } catch (e) {
    const reason = e instanceof EpaycoError ? `No se pudo verificar con ePayco (${e.kind}): ${e.message}` : `Error inesperado verificando el pago: ${e instanceof Error ? e.message : e}`;
    verdict = { kind: "review" as const, reason };
  }

  if (verdict.kind === "pending") {
    // No es definitivo: se libera el ref para poder consultarlo de nuevo; la venta sigue esperando
    await query("DELETE FROM payment_refs WHERE ref_payco = $1 AND outcome = 'procesando'", [ref]);
    await query("UPDATE sales SET payment_status = 'pendiente', epayco_ref = $2 WHERE id = $1 AND status = 'esperando_pago'", [saleId, ref]);
    await writeLog("pago", `Pago de ${sale.local_number} PENDIENTE en ePayco`, { detail: { sale_id: saleId, ref_payco: ref, tx: tx ? detailOf(tx) : null } });
    return result(saleId, "pendiente", sale.local_number);
  }

  const kind = verdict.kind === "approved" ? "approved" : verdict.kind === "rejected" ? "rejected" : "review";
  const reason = verdict.kind === "approved" ? "Pago aprobado y verificado" : verdict.reason;
  const outcome = await settle({ saleId, ref, kind, reason, tx: tx ?? undefined });

  await writeLog("pago", `Pago de ${sale.local_number}: ${outcome.toUpperCase()}${outcome === "pagado" ? "" : ` — ${reason}`}`, {
    level: outcome === "pagado" || outcome === "rechazado" ? "info" : "error",
    detail: { sale_id: saleId, ref_payco: ref, outcome, reason, source, tx: tx ? detailOf(tx) : null },
  });
  return result(saleId, outcome, sale.local_number, outcome === "pagado");
}

/** Cobros que no se confirmaron en 10 minutos → pago_fallido ("tiempo agotado"). Se ejecuta al consultar el estado. */
export async function expireWaitingPayments(saleId?: string): Promise<number> {
  if (!transitionAllowed("esperando_pago", "pago_fallido")) throw new Error("Transición no permitida");
  const { rows } = await query<{ id: string; local_number: string }>(
    `UPDATE sales SET status = 'pago_fallido', payment_status = 'vencido',
            payment_failure_reason = 'Tiempo agotado: el pago no se confirmó en ${getEpaycoConfig().expiresMinutes} minutos'
      WHERE status = 'esperando_pago' AND payment_expires_at IS NOT NULL AND payment_expires_at < now()
        AND ($1::uuid IS NULL OR id = $1)
      RETURNING id, local_number`,
    [saleId ?? null]
  );
  for (const r of rows) await writeLog("pago", `Cobro ${r.local_number} VENCIDO (tiempo agotado)`, { level: "warn", detail: { sale_id: r.id } });
  return rows.length;
}
