// INTENTOS de pago electrónico. Una venta puede tener varios intentos (el cliente cancela, el banco rechaza, vuelve a elegir…).
// Cada intento tiene su PROPIA referencia hacia ePayco (la 1.ª = número de compra, las siguientes con sufijo: K01-000123-2) para no
// reutilizar una transacción ya cancelada o rechazada. Todos son de la MISMA venta. Reglas que hace cumplir el SERVIDOR:
//   - solo se abre un intento si la venta sigue 'esperando_pago' y no ha vencido (una venta aprobada nunca abre otro);
//   - mientras haya un intento 'pendiente' (p. ej. PSE) o 'aprobado' NO se puede abrir otro;
//   - un intento 'abierto' (sin resultado) solo se reemplaza si quien llama lo pide expresamente (cambiar de QR a pantalla, o la
//     ventana de ePayco nunca llegó a abrirse); en el flujo normal "Intentar de nuevo" solo existe tras un resultado negativo.
// Sin datos de tarjeta: aquí solo hay referencias, estados y fechas.
import { pool, query } from "../db";
import { writeLog } from "../log";
import { transitionSale } from "../sale-states";
import { getEpaycoConfig } from "./config";
import { payUrlFor, qrAvailable, type PayChannel } from "./channel";
import { createSaleSession } from "./session";

export type AttemptStatus = "abierto" | "pendiente" | "aprobado" | "rechazado" | "cancelado" | "vencido" | "reemplazado" | "por_revisar";
export type Attempt = {
  id: number; sale_id: string; attempt_no: number; invoice: string; channel: PayChannel; session_id: string | null;
  status: AttemptStatus; ref_payco: string | null; reason: string | null; checks: number; created_at: Date; closed_at: Date | null;
  webhook_at: Date | null; qr_opened_at: Date | null;
};

/**
 * EVIDENCIA de que el pago de un intento puede estar en curso: ya se conoce su referencia larga (ref_payco), ePayco dijo "pendiente",
 * o llegó un aviso (webhook) con su referencia. Con evidencia el servidor NO deja abrir otro intento (riesgo de doble cobro).
 */
export const hasEvidence = (a: Pick<Attempt, "ref_payco" | "status" | "webhook_at">) => !!a.ref_payco || a.status === "pendiente" || !!a.webhook_at;

export const NEGATIVE: AttemptStatus[] = ["rechazado", "cancelado", "vencido"];
const COLS = "id, sale_id, attempt_no, invoice, channel, session_id, status, ref_payco, reason, checks, created_at, closed_at, webhook_at, qr_opened_at";

export const attemptInvoice = (localNumber: string, no: number) => (no <= 1 ? localNumber : `${localNumber}-${no}`);

export const listAttempts = async (saleId: string) =>
  (await query<Attempt>(`SELECT ${COLS} FROM payment_attempts WHERE sale_id = $1 ORDER BY attempt_no`, [saleId])).rows;

/** Referencias (x_id_invoice) que ePayco puede devolver para esta venta: el número de compra y la de cada intento */
export async function acceptedInvoices(saleId: string, localNumber: string): Promise<string[]> {
  const r = await query<{ invoice: string }>("SELECT invoice FROM payment_attempts WHERE sale_id = $1", [saleId]);
  return [...new Set([localNumber, ...r.rows.map((x) => x.invoice)])];
}

/** Lo que la pantalla necesita saber del último intento */
export type AttemptView = {
  no: number; status: AttemptStatus; channel: PayChannel; reason: string | null;
  /** hay evidencia de que el pago puede estar en curso (ref_payco, pendiente o aviso del webhook) */
  evidence: boolean;
  /** la página QR de este intento ya se abrió en un celular */
  qr_opened: boolean;
} | null;
export async function latestAttemptView(saleId: string): Promise<AttemptView> {
  const a = (await query<Attempt>(`SELECT ${COLS} FROM payment_attempts WHERE sale_id = $1 ORDER BY attempt_no DESC LIMIT 1`, [saleId])).rows[0];
  return a ? { no: a.attempt_no, status: a.status, channel: a.channel, reason: a.reason, evidence: hasEvidence(a), qr_opened: !!a.qr_opened_at } : null;
}

/** Marca que se abrió /pagar/<código> en un celular para el intento QR abierto (el cambio de canal queda bloqueado desde ese momento). */
export async function markQrOpened(saleId: string) {
  await query(
    `UPDATE payment_attempts SET qr_opened_at = COALESCE(qr_opened_at, now())
      WHERE id = (SELECT id FROM payment_attempts WHERE sale_id = $1 AND channel = 'qr' AND status IN ('abierto','pendiente') ORDER BY attempt_no DESC LIMIT 1)`,
    [saleId]
  );
}

/** Anota que llegó un aviso firmado del webhook con la referencia (invoice) de un intento: eso cuenta como evidencia de pago. */
export async function markWebhook(invoice: string) {
  await query("UPDATE payment_attempts SET webhook_at = COALESCE(webhook_at, now()) WHERE invoice = $1", [invoice]);
}

/**
 * Cambia el estado de un intento (por su referencia; si no se conoce, el último que sigue abierto o pendiente).
 * Nunca "retrocede" un intento ya aprobado.
 */
export async function markAttempt(
  exec: (t: string, v: unknown[]) => Promise<unknown>,
  saleId: string,
  invoice: string | null,
  status: AttemptStatus,
  extra: { ref?: string | null; reason?: string | null } = {}
) {
  await exec(
    `UPDATE payment_attempts SET status = $3, reason = COALESCE($4, reason), ref_payco = COALESCE($5, ref_payco),
            closed_at = CASE WHEN $3 IN ('pendiente','abierto') THEN NULL ELSE COALESCE(closed_at, now()) END
      WHERE id = (SELECT id FROM payment_attempts WHERE sale_id = $1 AND status <> 'aprobado'
                    AND ($2::text IS NULL OR invoice = $2 OR status IN ('abierto','pendiente'))
                  ORDER BY (invoice = $2) DESC NULLS LAST, attempt_no DESC LIMIT 1)`,
    [saleId, invoice, status, extra.reason ?? null, extra.ref ?? null]
  );
}

/** Guarda la referencia LARGA conocida en el intento abierto o pendiente más reciente (es lo que usa la consulta activa). */
export async function attachRef(saleId: string, ref: string) {
  await query(
    `UPDATE payment_attempts SET ref_payco = $2
      WHERE id = (SELECT id FROM payment_attempts WHERE sale_id = $1 AND status IN ('abierto','pendiente') ORDER BY attempt_no DESC LIMIT 1)
        AND (ref_payco IS DISTINCT FROM $2)`,
    [saleId, ref]
  );
}

export type OpenResult =
  | { ok: true; attemptNo: number; invoice: string; channel: PayChannel; sessionId: string | null; payUrl: string | null }
  | { ok: false; status: number; error: string; code: "pendiente" | "evidencia" | "qr_abierto" | "abierto" | "pagada" | "vencida" | "no_existe" | "qr_no_disponible" | "ePayco" };

/** Reserva el intento (INSERT bajo bloqueo de la venta). No habla con ePayco. */
async function reserve(
  saleId: string,
  channel: PayChannel,
  o: { replace?: boolean; reuseOpenQr?: boolean }
): Promise<{ ok: true; attempt: Attempt; localNumber: string; total: number; payToken: string | null; reused: boolean } | Extract<OpenResult, { ok: false }>> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = (
      await c.query<{ local_number: string; total: number; status: string; expires: Date | null; pay_token: string | null }>(
        "SELECT local_number, total::float8 AS total, status, payment_expires_at AS expires, pay_token FROM sales WHERE id = $1 AND payment_method = 'epayco' FOR UPDATE",
        [saleId]
      )
    ).rows[0];
    if (!s) {
      await c.query("ROLLBACK");
      return { ok: false, status: 404, error: "Venta no encontrada", code: "no_existe" };
    }
    if (s.status !== "esperando_pago") {
      await c.query("ROLLBACK");
      const paid = ["pagado", "invoicing", "invoiced", "pending", "failed", "revisar"].includes(s.status);
      return { ok: false, status: 409, error: paid ? "Esta compra ya fue pagada." : "Este cobro ya no admite otro intento.", code: paid ? "pagada" : "vencida" };
    }
    if (!s.expires || s.expires.getTime() < Date.now()) {
      await c.query("ROLLBACK");
      return { ok: false, status: 409, error: "Se agotó el tiempo de este cobro.", code: "vencida" };
    }
    const all = (await c.query<Attempt>(`SELECT ${COLS} FROM payment_attempts WHERE sale_id = $1 ORDER BY attempt_no`, [saleId])).rows;
    if (all.some((a) => a.status === "aprobado")) {
      await c.query("ROLLBACK");
      return { ok: false, status: 409, error: "Esta compra ya fue pagada.", code: "pagada" };
    }
    if (all.some((a) => a.status === "pendiente")) {
      await c.query("ROLLBACK");
      return { ok: false, status: 409, error: "Su pago está en proceso. No lo repita: estamos esperando la confirmación de su banco.", code: "pendiente" };
    }
    const last = all.at(-1);
    if (last?.status === "abierto") {
      if (o.reuseOpenQr && last.channel === "qr" && channel === "qr") {
        await c.query("COMMIT");
        return { ok: true, attempt: last, localNumber: s.local_number, total: s.total, payToken: s.pay_token, reused: true };
      }
      if (!o.replace) {
        await c.query("ROLLBACK");
        return { ok: false, status: 409, error: "Ya hay un intento de pago abierto para esta compra.", code: "abierto" };
      }
      // Reemplazar un intento abierto SOLO si no hay evidencia de pago y su página QR nunca se abrió en un celular
      if (last.qr_opened_at) {
        await c.query("ROLLBACK");
        return { ok: false, status: 409, error: "Este pago se abrió en un celular. Termine el pago allí o cancele la compra.", code: "qr_abierto" };
      }
      if (hasEvidence(last)) {
        await c.query("ROLLBACK");
        return { ok: false, status: 409, error: "Su pago puede estar en curso. No lo repita: estamos esperando la confirmación.", code: "evidencia" };
      }
      await c.query("UPDATE payment_attempts SET status = 'reemplazado', closed_at = now() WHERE id = $1", [last.id]);
    }
    const no = (last?.attempt_no ?? 0) + 1;
    const ins = await c.query<Attempt>(
      `INSERT INTO payment_attempts (sale_id, attempt_no, invoice, channel) VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
      [saleId, no, attemptInvoice(s.local_number, no), channel]
    );
    await c.query("COMMIT");
    return { ok: true, attempt: ins.rows[0], localNumber: s.local_number, total: s.total, payToken: s.pay_token, reused: false };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Abre un intento nuevo para la venta con el canal elegido. 'pantalla' crea la sesión de ePayco AHORA (con la referencia del intento);
 * 'qr' no crea sesión (la crea el celular al abrir /pagar/<código>, ver phoneAttempt).
 */
export async function openAttempt(p: {
  saleId: string;
  channel: PayChannel;
  userId: number;
  /** a dónde vuelve el navegador del equipo tras pagar en pantalla */
  responseUrl: string;
  where: string;
  replace?: boolean;
}): Promise<OpenResult> {
  if (p.channel === "qr" && !qrAvailable()) return { ok: false, status: 409, error: "El pago con QR no está disponible (falta el dominio público).", code: "qr_no_disponible" };
  const r = await reserve(p.saleId, p.channel, { replace: p.replace });
  if (!r.ok) return r;
  const a = r.attempt;
  let sessionId: string | null = null;
  if (p.channel === "pantalla") {
    try {
      const s = await createSaleSession({ saleId: p.saleId, localNumber: r.localNumber, invoice: a.invoice, total: r.total, wantedUrl: p.responseUrl, userId: p.userId, where: p.where });
      sessionId = s.sessionId;
    } catch (e) {
      // No se pudo crear la sesión: el intento no llegó a existir para ePayco
      await markAttempt((t, v) => query(t, v), p.saleId, a.invoice, "rechazado", { reason: "No se pudo crear la sesión de pago en ePayco" });
      throw e;
    }
  }
  await query(
    `UPDATE sales SET pay_channel = $2, pay_channel_changed_at = now(), epayco_session_id = COALESCE($3, epayco_session_id) WHERE id = $1 AND status = 'esperando_pago'`,
    [p.saleId, p.channel, sessionId]
  );
  if (sessionId) await query("UPDATE payment_attempts SET session_id = $2 WHERE id = $1", [a.id, sessionId]);
  await writeLog("pago", `Intento ${a.attempt_no} de ${r.localNumber} abierto (${p.channel === "qr" ? "QR en el celular" : "en pantalla"}, referencia ${a.invoice})`, {
    userId: p.userId,
    detail: { sale_id: p.saleId, attempt: a.attempt_no, invoice: a.invoice, channel: p.channel, session_id: sessionId, replace: !!p.replace },
  });
  return { ok: true, attemptNo: a.attempt_no, invoice: a.invoice, channel: p.channel, sessionId, payUrl: p.channel === "qr" ? payUrlFor(r.payToken) : null };
}

/**
 * Intento para la página pública /pagar/<código> (el celular). Si el intento QR sigue abierto se usa ese (recargar la página no
 * crea otro); si el anterior terminó mal (rechazado/cancelado/vencido) se abre uno nuevo; con un pago pendiente o aprobado, no.
 */
export async function phoneAttempt(saleId: string): Promise<{ ok: true; invoice: string; attemptNo: number; localNumber: string; total: number } | Extract<OpenResult, { ok: false }>> {
  const r = await reserve(saleId, "qr", { reuseOpenQr: true });
  if (!r.ok) return r;
  if (!r.reused) {
    await query(`UPDATE sales SET pay_channel = 'qr', pay_channel_changed_at = now() WHERE id = $1 AND status = 'esperando_pago' AND pay_channel IS DISTINCT FROM 'qr'`, [saleId]);
  }
  return { ok: true, invoice: r.attempt.invoice, attemptNo: r.attempt.attempt_no, localNumber: r.localNumber, total: r.total };
}

/**
 * "Cancelar compra". Idempotente.
 *  - Con un intento PENDIENTE (ePayco ya dijo "pendiente": p. ej. PSE en el banco) el dinero puede estar en camino: la venta pasa a
 *    pago_por_revisar (un admin la ve; si el pago se aprueba, decide Facturar). Nunca se pierde.
 *  - Sin pendiente: pago_fallido (cancelada). Si luego llegara una aprobación, la lógica de siempre la deja en pago_tardio.
 */
export async function cancelSale(saleId: string, who: string, opts: { keepForReview?: boolean } = {}): Promise<{ status: string; kept_for_review: boolean }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const s = (await c.query<{ status: string; local_number: string }>("SELECT status, local_number FROM sales WHERE id = $1 FOR UPDATE", [saleId])).rows[0];
    if (!s || s.status !== "esperando_pago") {
      await c.query("ROLLBACK");
      return { status: s?.status ?? "desconocido", kept_for_review: false };
    }
    const exec = (t: string, v: unknown[]) => c.query(t, v);
    // ¿Hay un intento con EVIDENCIA de pago (ref_payco, pendiente o aviso del webhook)? Entonces el dinero puede estar en camino.
    const evidence = (
      await c.query("SELECT 1 FROM payment_attempts WHERE sale_id = $1 AND status IN ('abierto','pendiente') AND (ref_payco IS NOT NULL OR status = 'pendiente' OR webhook_at IS NOT NULL)", [saleId])
    ).rowCount ?? 0;
    const pending = opts.keepForReview || evidence;
    let status: string;
    if (pending) {
      // Los intentos NO se tocan: la consulta activa los sigue verificando hasta que venza el cobro
      await transitionSale(saleId, ["esperando_pago"], "pago_por_revisar", {
        payment_status: "por_revisar",
        payment_failure_reason: opts.keepForReview
          ? "El kiosco se reinició por inactividad con el pago en proceso o sin confirmar. Si se aprueba, un administrador decide (Facturar si el dinero entró)."
          : "El cliente canceló mientras su pago estaba en proceso en ePayco. Si se aprueba, un administrador decide (Facturar si el dinero entró).",
      }, exec);
      status = "pago_por_revisar";
    } else {
      await transitionSale(saleId, ["esperando_pago"], "pago_fallido", { payment_status: "cancelado", payment_failure_reason: "Compra cancelada por el cliente" }, exec);
      await c.query("UPDATE payment_attempts SET status = 'cancelado', closed_at = COALESCE(closed_at, now()) WHERE sale_id = $1 AND status = 'abierto'", [saleId]);
      status = "pago_fallido";
    }
    await c.query("COMMIT");
    await writeLog("pago", `Compra ${s.local_number} CANCELADA (${who})${pending ? ": con un pago en proceso o sin confirmar → queda para revisión" : ""}`, {
      level: pending ? "warn" : "info",
      detail: { sale_id: saleId, pendiente: !!pending },
    });
    return { status, kept_for_review: !!pending };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export const pollSeconds = () => getEpaycoConfig().pollSeconds;
