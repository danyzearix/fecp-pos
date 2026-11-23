// Procesa el pago de una venta del kiosco a partir de un ref_payco. Reglas:
//  - Cada ref_payco se procesa UNA sola vez (INSERT en payment_refs = reclamo atómico).
//  - El servidor consulta a ePayco por su cuenta; nada que mande el navegador cuenta como prueba de pago.
//  - Solo un veredicto 'approved' marca la venta como 'pagado'. Fallas, formatos raros o datos que no coinciden
//    la dejan en 'pago_por_revisar'. Un pago aprobado DESPUÉS de vencer el cobro queda en 'pago_tardio'.
//  - Un SEGUNDO pago aprobado de la misma venta (p. ej. pagó por QR y también en pantalla) NO toca la venta ni se factura:
//    queda en payment_refs como 'duplicado' con el motivo "Pago duplicado de la venta X, reembolsar" y aparece en
//    /admin/pagos-por-revisar → "Pagos duplicados".
//  - "No pude verificar" NO es "no coincide": si la consulta a ePayco no se pudo resolver (red, error, referencia corta), la
//    referencia NO se consume y la venta sigue esperando (outcome 'no_verificado'; el webhook responde 500 para que ePayco
//    reintente). Solo lo que SÍ llegó y no coincide (monto, invoice, firma, modo de prueba, código) va a 'por revisar'.
//    Tras MAX_UNRESOLVED intentos sin poder verificar, pasa a 'por revisar' para que un admin lo vea.
//  - Un mismo pago visto con dos referencias (corta y larga) es el MISMO pago: no es un duplicado.
//  - Nunca factura aquí: devuelve startInvoicing y quien llama arranca la facturación (etapa 4).
import { pool, query } from "../db";
import { writeLog } from "../log";
import { transitionAllowed, transitionSale, type SaleStatus } from "../sale-states";
import { EpaycoError, fetchTransaction, isShortRef, isUnresolvedError, type EpaycoDiag, type NormalizedTx } from "./adapter";
import { getEpaycoConfig } from "./config";
import { judgeTransaction } from "./verify";
import { acceptedInvoices, attachRef, markAttempt, markRefUsed, REF_KIND_TEXT, type RefKind } from "./attempts";

export class PaymentInputError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type PaymentOutcome =
  | "pagado" | "pendiente" | "rechazado" | "cancelado" | "por_revisar" | "tardio" | "duplicado" | "en_proceso" | "ya_procesado"
  /** la consulta a ePayco no se pudo resolver: la venta sigue esperando y se puede reintentar */
  | "no_verificado";
export type PaymentResult = {
  outcome: PaymentOutcome;
  saleStatus: string;
  /** Mensaje seguro para mostrar al cliente en el kiosco (sin detalles internos) */
  message: string;
  startInvoicing: boolean;
  /** (solo no_verificado) por qué no se pudo resolver la consulta: 'notfound' = ePayco no reconoció la referencia; 'network'/'http' = pasajero */
  unresolvedKind?: string;
  /** motivo interno (para el panel del admin; nunca para el cliente) */
  reason?: string;
  /** cómo fue la consulta a ePayco: tipo de referencia, HTTP, milisegundos (sin valores ni datos personales) */
  lookup?: { ref_kind: string; http: number | null; ms: number; error_kind?: string; cod_response?: number; response?: string | null };
};

const REF_RE = /^[A-Za-z0-9_-]{4,64}$/;
const MAX_REFS_PER_SALE = 5;
/** Intentos de verificación que no se pudieron resolver antes de mandar la venta a revisión (para que no quede invisible). */
const MAX_UNRESOLVED = 60;

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
    case "cancelado":
      return "Usted canceló el pago. No se hizo ningún cobro.";
    case "por_revisar":
    case "tardio":
    case "duplicado":
      return `No pudimos confirmar su pago automáticamente. Acérquese a la caja con este número: ${local}.`;
    case "en_proceso":
    case "no_verificado":
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

const result = async (
  saleId: string, outcome: PaymentOutcome, local: string, startInvoicing = false, unresolvedKind?: string,
  extra: Pick<PaymentResult, "reason" | "lookup"> = {}
): Promise<PaymentResult> => {
  const s = await loadSale(saleId);
  return { outcome, saleStatus: s?.status ?? "desconocido", message: customerMessage(outcome, local), startInvoicing, ...(unresolvedKind ? { unresolvedKind } : {}), ...extra };
};

export const duplicateReason = (local: string, txRef?: string | null) =>
  `Pago duplicado de la venta ${local}, reembolsar${txRef ? ` (transacción ${txRef}: confirme en el panel de ePayco que es OTRO cobro antes de reembolsar)` : ""}`;

const FROM_REF: Record<string, PaymentOutcome> = {
  aprobado: "pagado",
  rechazado: "rechazado",
  cancelado: "cancelado",
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
  localNumber: string;
  ref: string;
  kind: "approved" | "rejected" | "review";
  /** (solo rejected) el cliente canceló o abandonó: no fue el banco */
  cancelled?: boolean;
  reason: string;
  tx?: NormalizedTx;
  amount?: number;
  /** diagnóstico (solo códigos y nombres de campos) que se guarda cuando no hay transacción */
  diag?: unknown;
  /** referencia que se guarda en payment_attempts.ref_payco: solo la LARGA (con la corta o el transaction_id no se debe guardar ahí) */
  attemptRef?: string | null;
}): Promise<PaymentOutcome> {
  const c = await pool.connect();
  const exec = (t: string, v: unknown[]) => c.query(t, v);
  try {
    await c.query("BEGIN");
    const row = (await c.query<{ status: SaleStatus; payment_status: string | null }>("SELECT status, payment_status FROM sales WHERE id = $1 FOR UPDATE", [p.saleId])).rows[0];
    const cur = row?.status;
    let outcome: PaymentOutcome;
    let refOutcome: string;
    let refReason = p.reason;

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
        await markAttempt(exec, p.saleId, p.tx?.invoice ?? null, "aprobado", { ref: p.attemptRef ?? null });
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
        await markAttempt(exec, p.saleId, p.tx?.invoice ?? null, "aprobado", { ref: p.attemptRef ?? null });
        outcome = "tardio"; refOutcome = "tardio";
      } else {
        // La venta ya está pagada/facturada/en revisión/anulada. ¿Es el MISMO pago visto con otra referencia (la corta y la
        // larga son el mismo pago) o un SEGUNDO pago de verdad? Se compara la identidad de la transacción, no el texto de la referencia.
        const same = p.tx
          ? (
              await c.query<{ same: boolean }>(
                `SELECT (EXISTS (SELECT 1 FROM payment_refs WHERE sale_id = $1 AND ref_payco <> $2
                                    AND (ref_payco = $3 OR detail->>'x_ref_payco' = $3 OR ($4::text IS NOT NULL AND detail->>'transaction_id' = $4)))
                       OR EXISTS (SELECT 1 FROM sales WHERE id = $1 AND (payment_reference = $3 OR ($4::text IS NOT NULL AND epayco_transaction_id = $4)))) AS same`,
                [p.saleId, p.ref, p.tx.refPayco, p.tx.transactionId]
              )
            ).rows[0]?.same
          : false;
        // ¿Es el pago de un intento que quedó PENDIENTE y luego el cliente canceló la compra (la venta pasó a revisión)? Entonces no es
        // un duplicado: es ese mismo pago que por fin se aprobó. No se factura solo: un administrador decide.
        const pend = p.tx
          ? (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM payment_attempts WHERE sale_id = $1 AND invoice = $2 AND status IN ('pendiente','abierto')", [p.saleId, p.tx.invoice])).rows[0]?.n ?? 0
          : 0;
        if (cur === "pago_por_revisar" && row?.payment_status === "por_confirmar") {
          // El cobro venció con un aviso firmado de pago aprobado (o un pago en curso) que no se había podido confirmar. ePayco ACABA de
          // confirmarlo: es el pago de esta venta, se factura normalmente (no es un duplicado ni necesita decisión del admin).
          await transitionSale(
            p.saleId, ["pago_por_revisar"], "pagado",
            {
              payment_status: "aprobado", payment_failure_reason: null, last_error: null,
              epayco_ref: p.ref, epayco_transaction_id: p.tx?.transactionId ?? null, payment_reference: p.tx?.refPayco ?? p.ref,
            },
            exec
          );
          await markAttempt(exec, p.saleId, p.tx?.invoice ?? null, "aprobado", { ref: p.attemptRef ?? null });
          outcome = "pagado"; refOutcome = "aprobado";
          refReason = "Pago aprobado y verificado (el cobro había vencido con el pago en curso)";
        } else if (pend > 0 && cur === "pago_por_revisar" && !same) {
          await markAttempt(exec, p.saleId, p.tx?.invoice ?? null, "aprobado", { ref: p.attemptRef ?? null });
          outcome = "por_revisar"; refOutcome = "por_revisar";
          refReason = `Pago APROBADO (ref. ${p.tx?.refPayco}) de un intento que estaba pendiente cuando se canceló la compra. Un administrador decide (Facturar si el dinero entró).`;
        } else if (same && (cur === "pago_por_revisar" || cur === "pago_tardio")) {
          // Ese pago YA dejó la venta en revisión (p. ej. la primera verificación falló). Sigue sin facturarse sola: decide un admin.
          outcome = "por_revisar"; refOutcome = "por_revisar";
          refReason = `Pago verificado, pero es el MISMO pago (ref. ${p.tx?.refPayco}) que ya dejó esta venta en revisión. Un administrador decide (Facturar si el dinero entró).`;
        } else if (same) {
          outcome = "ya_procesado"; refOutcome = "aprobado";
          refReason = `Mismo pago ya registrado con otra referencia (ref. ${p.tx?.refPayco})`;
        } else {
          outcome = "duplicado"; refOutcome = "duplicado"; refReason = duplicateReason(p.localNumber, p.tx?.refPayco ?? null);
        }
      }
    } else if (p.kind === "rejected") {
      if (cur === "esperando_pago") {
        // El intento termina mal, pero la VENTA sigue esperando mientras no venza: el cliente puede abrir otro intento (con otra
        // referencia). Si ya venció, pasa a pago_fallido como siempre.
        const expired = (await c.query<{ exp: boolean }>("SELECT (payment_expires_at IS NOT NULL AND payment_expires_at < now()) AS exp FROM sales WHERE id = $1", [p.saleId])).rows[0]?.exp;
        const status = p.cancelled ? "cancelado" : "rechazado";
        if (expired) {
          await transitionSale(p.saleId, ["esperando_pago"], "pago_fallido", { payment_status: status, payment_failure_reason: p.reason }, exec);
        } else {
          await c.query("UPDATE sales SET payment_status = $2, payment_failure_reason = $3 WHERE id = $1 AND status = 'esperando_pago'", [p.saleId, status, p.reason]);
        }
        await markAttempt(exec, p.saleId, p.tx?.invoice ?? null, status, { ref: p.attemptRef ?? null, reason: p.reason });
      } else if (cur === "pago_por_revisar") {
        // La venta quedó "por revisar" porque el kiosco se reinició o se canceló con el pago en curso. Si ePayco confirma que NO hubo pago
        // (rechazado/cancelado) y no hay otro intento aprobado o por revisar, ya no hay nada que revisar: se cierra.
        const status = p.cancelled ? "cancelado" : "rechazado";
        await markAttempt(exec, p.saleId, p.tx?.invoice ?? null, status, { ref: p.attemptRef ?? null, reason: p.reason });
        const other = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM payment_attempts WHERE sale_id = $1 AND status IN ('abierto','pendiente','aprobado','por_revisar')", [p.saleId])).rows[0]?.n ?? 0;
        if (!other) await transitionSale(p.saleId, ["pago_por_revisar"], "pago_fallido", { payment_status: status, payment_failure_reason: p.reason }, exec);
      }
      outcome = p.cancelled ? "cancelado" : "rechazado"; refOutcome = p.cancelled ? "cancelado" : "rechazado";
    } else {
      if (cur === "esperando_pago") {
        await transitionSale(p.saleId, ["esperando_pago"], "pago_por_revisar", { payment_status: "por_revisar", payment_failure_reason: p.reason, epayco_ref: p.ref }, exec);
        await markAttempt(exec, p.saleId, p.tx?.invoice ?? null, "por_revisar", { ref: p.attemptRef ?? null, reason: p.reason });
      }
      outcome = "por_revisar"; refOutcome = "por_revisar";
    }

    await c.query(
      `UPDATE payment_refs SET outcome = $2, reason = $3, amount = $4, detail = $5, finished_at = now() WHERE ref_payco = $1`,
      [p.ref, refOutcome, refReason, p.amount ?? p.tx?.amount ?? null, p.tx ? JSON.stringify(detailOf(p.tx)) : p.diag ? JSON.stringify({ diag: p.diag }) : null]
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
export type PaymentCheckSource = "kiosco" | "webhook" | "publica" | "admin" | "poller";

const g = globalThis as unknown as { __shortRefLogged?: Set<string> };

export type ProcessOpts = {
  /**
   * Permite consultar con una referencia que NO es la larga (x_transaction_id o x_ref_payco, que trae el webhook). Sin esto, una referencia
   * corta (solo dígitos) que mande un navegador NO se consulta (comportamiento de siempre). 'kind' dice de qué tipo es.
   */
  kind?: RefKind;
  /** (solo con kind distinto de 'larga') cuenta una consulta sin resolver en verify_attempts. Por defecto solo la larga cuenta. */
  countUnresolved?: boolean;
  /** Transacción ya construida desde un webhook FIRMADO (EPAYCO_TRUST_SIGNED_WEBHOOK): no se consulta a ePayco. Ver trust.ts */
  trusted?: NormalizedTx;
};

export async function processPayment(saleId: string, refRaw: string, source: PaymentCheckSource, opts: ProcessOpts = {}): Promise<PaymentResult> {
  const ref = String(refRaw ?? "").trim();
  if (!REF_RE.test(ref)) throw new PaymentInputError(400, "ref_payco no válido");

  const sale = await loadSale(saleId);
  // Cobros electrónicos: del kiosco o de la caja (los dos nacen en 'esperando_pago' y se verifican igual con ePayco)
  if (!sale || !["kiosco", "caja"].includes(sale.source) || sale.payment_method !== "epayco") throw new PaymentInputError(404, "Venta no encontrada");

  // La consulta a ePayco SOLO funciona con la referencia larga. Con la corta (solo dígitos) no se llama a ePayco ni se
  // consume nada: se espera la larga (la trae el navegador al volver de ePayco, o el admin desde el panel).
  const isLong = !opts.kind || opts.kind === "larga";
  if (isShortRef(ref) && !opts.kind) {
    const seenKey = `${saleId}:${ref}`;
    const logged = (g.__shortRefLogged ??= new Set());
    if (!logged.has(seenKey)) {
      if (logged.size > 2000) logged.clear();
      logged.add(seenKey);
      await writeLog("pago", `Verificación de ${sale.local_number} con la referencia CORTA (${ref}): no se consulta a ePayco; falta la referencia larga (ref_payco)`, {
        level: "warn", detail: { sale_id: saleId, ref_kind: "corta", ref_len: ref.length, source },
      });
    }
    return result(saleId, "no_verificado", sale.local_number);
  }

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
  // La referencia larga queda guardada en el intento: así el servidor puede seguir consultando a ePayco por su cuenta (poller)
  if (isLong) await attachRef(saleId, ref).catch(() => {});
  const attemptRef = isLong ? ref : null;

  // ---- Consultar a ePayco (adaptador) y juzgar ----
  let tx: NormalizedTx | null = null;
  const t0 = Date.now();
  let lookup: PaymentResult["lookup"];
  let verdict;
  let diag: (EpaycoDiag & { error_kind?: string; ref_kind?: string; ref_len?: number }) | undefined;
  let unresolved = false;
  try {
    tx = opts.trusted ?? (await fetchTransaction(ref));
    lookup = { ref_kind: opts.trusted ? "firma" : (opts.kind ?? "larga"), http: opts.trusted ? null : 200, ms: Date.now() - t0, cod_response: tx.codResponse, response: tx.response };
    verdict = judgeTransaction(tx, { local_number: sale.local_number, total: sale.total, invoices: await acceptedInvoices(saleId, sale.local_number) }, { saleId, testMode: getEpaycoConfig().testMode });
  } catch (e) {
    if (e instanceof EpaycoError) diag = { ...e.diag, error_kind: e.kind, ref_kind: opts.kind ?? "larga", ref_len: ref.length };
    lookup = { ref_kind: opts.kind ?? "larga", http: e instanceof EpaycoError ? e.diag?.http ?? null : null, ms: Date.now() - t0, error_kind: e instanceof EpaycoError ? e.kind : "error" };
    const reason = e instanceof EpaycoError ? `No se pudo verificar con ePayco (${e.kind}): ${e.message}` : `Error inesperado verificando el pago: ${e instanceof Error ? e.message : e}`;
    verdict = { kind: "review" as const, reason };
    unresolved = isUnresolvedError(e);
  }

  // ---- No se pudo RESOLVER la consulta (red, error de ePayco, referencia no encontrada) ----
  // No es "algo no coincide": no se consume la referencia ni se manda a revisión de inmediato; la venta sigue esperando.
  if (unresolved) {
    // Solo la referencia larga cuenta hacia "demasiados intentos": las demás (transaction_id / corta) son pruebas adicionales que pueden no servir nunca
    const counts = isLong || opts.countUnresolved;
    const att = await query<{ n: number }>(
      counts
        ? "UPDATE sales SET verify_attempts = verify_attempts + 1 WHERE id = $1 AND status = 'esperando_pago' RETURNING verify_attempts AS n"
        : "SELECT verify_attempts AS n FROM sales WHERE id = $1",
      [saleId]
    );
    const attempts = att.rows[0]?.n ?? 0;
    // Se registra el 1.º, 2.º, 3.º intento y luego cada 10.º (la pantalla de la caja reintenta cada 3 s)
    if (counts && (attempts <= 3 || attempts % 10 === 0)) {
      await writeLog("pago", `No se pudo verificar el pago de ${sale.local_number} con ePayco (intento ${attempts}): ${verdict.kind === "review" ? verdict.reason : ""}`, {
        level: "warn", detail: { sale_id: saleId, source, attempts, diag },
      });
    }
    if (attempts < MAX_UNRESOLVED || !counts) {
      await query("DELETE FROM payment_refs WHERE ref_payco = $1 AND outcome = 'procesando'", [ref]);
      return result(saleId, "no_verificado", sale.local_number, false, diag?.error_kind ?? "notfound", { reason: verdict.kind === "review" ? verdict.reason : undefined, lookup });
    }
    // Demasiados intentos sin poder verificar: a revisión, para que un admin lo vea (más abajo, por el camino de siempre)
  }

  if (verdict.kind === "pending") {
    // No es definitivo: se libera el ref para poder consultarlo de nuevo; la venta sigue esperando
    await query("DELETE FROM payment_refs WHERE ref_payco = $1 AND outcome = 'procesando'", [ref]);
    await query("UPDATE sales SET payment_status = 'pendiente', epayco_ref = $2 WHERE id = $1 AND status = 'esperando_pago'", [saleId, isLong ? ref : null]);
    await markAttempt((t, v) => query(t, v), saleId, tx?.invoice ?? null, "pendiente", { ref: attemptRef });
    await writeLog("pago", `Pago de ${sale.local_number} PENDIENTE en ePayco`, { detail: { sale_id: saleId, ref_payco: ref, tx: tx ? detailOf(tx) : null } });
    return result(saleId, "pendiente", sale.local_number, false, undefined, { reason: verdict.reason, lookup });
  }

  const kind = verdict.kind === "approved" ? "approved" : verdict.kind === "rejected" ? "rejected" : "review";
  let reason = verdict.kind === "approved" ? "Pago aprobado y verificado" : verdict.reason;
  // ePayco SÍ devolvió la transacción con esta referencia: se anota cuál tipo funcionó (larga / transaction_id / corta / firma)
  if (tx && !unresolved) {
    const used: RefKind = opts.trusted ? "firma" : (opts.kind ?? "larga");
    await markRefUsed(saleId, tx.invoice, used).catch(() => {});
    if (!isLong || opts.trusted) await writeLog("pago", `Pago de ${sale.local_number}: ePayco ${opts.trusted ? "no se consultó (aviso firmado aceptado por EPAYCO_TRUST_SIGNED_WEBHOOK)" : `reconoció ${REF_KIND_TEXT[used]}`}`, { level: opts.trusted ? "warn" : "info", detail: { sale_id: saleId, ref_used: used, invoice: tx.invoice } });
  }
  const outcome = await settle({ saleId, localNumber: sale.local_number, ref, kind, reason, tx: tx ?? undefined, diag, cancelled: verdict.kind === "rejected" && verdict.cancelled, attemptRef });
  if (outcome === "duplicado") reason = duplicateReason(sale.local_number, tx?.refPayco ?? null);

  await writeLog("pago", `Pago de ${sale.local_number}: ${outcome.toUpperCase()}${outcome === "pagado" ? "" : ` — ${reason}`}`, {
    level: outcome === "pagado" || outcome === "rechazado" || outcome === "cancelado" ? "info" : "error",
    detail: { sale_id: saleId, ref_payco: ref, outcome, reason, source, tx: tx ? detailOf(tx) : null, diag: tx ? undefined : diag },
  });
  return result(saleId, outcome, sale.local_number, outcome === "pagado", undefined, { reason, lookup });
}

/**
 * Aviso firmado del webhook que llegó SIN la referencia larga: no se puede consultar a ePayco, así que NO se decide nada.
 * Solo se deja constancia en la venta (si el monto coincide) para que el panel la muestre como "aviso recibido, falta la
 * referencia larga". La confirmación llega por el navegador (que sí recibe ref_payco) o la hace un admin desde el panel.
 */
export async function recordWebhookHint(p: { saleId: string; ref: string; txId: string; amountRaw: string }): Promise<boolean> {
  const amount = Number(String(p.amountRaw).replace(/,/g, ""));
  if (!Number.isFinite(amount)) return false;
  const r = await query(
    `UPDATE sales SET webhook_hint_at = now(), webhook_hint_ref = $2, webhook_hint_txid = $3
      WHERE id = $1 AND status IN ('esperando_pago','pago_fallido') AND abs(total - $4::numeric) < 0.005`,
    [p.saleId, p.ref.slice(0, 40), p.txId.slice(0, 60), amount]
  );
  return (r.rowCount ?? 0) > 0;
}

/** Motivo que ve el admin cuando el cobro vence con un aviso firmado de pago APROBADO que no se pudo confirmar */
export const APPROVED_WEBHOOK_REASON = "ePayco avisó un pago aprobado que no se pudo confirmar automáticamente";

/**
 * Cobros que no se confirmaron a tiempo (10 minutos). Se ejecuta al consultar el estado y en la tarea de fondo. Reglas:
 *  - CON evidencia de pago en un intento vivo (aviso firmado de ePayco, referencia larga conocida o estado pendiente): la venta NO falla.
 *    Pasa a pago_por_revisar con payment_status 'por_confirmar' y el intento sigue abierto: la consulta activa lo sigue intentando y, si
 *    ePayco confirma el pago, se factura sola. Si nunca se confirma, un admin decide (o usa "Facturar con evidencia del webhook").
 *  - Aviso firmado que dice RECHAZADO/FALLIDO (x_cod_response 2/4/9/10/11) sin otra evidencia: eso NO es evidencia de pago.
 *  - SIN ninguna evidencia: pago_fallido ("tiempo agotado"), como siempre.
 */
export async function expireWaitingPayments(saleId?: string): Promise<number> {
  if (!transitionAllowed("esperando_pago", "pago_fallido") || !transitionAllowed("esperando_pago", "pago_por_revisar")) throw new Error("Transición no permitida");
  const evidenceSql = `EXISTS (SELECT 1 FROM payment_attempts a WHERE a.sale_id = s.id AND a.status IN ('abierto','pendiente')
                        AND (a.webhook_approved_at IS NOT NULL OR a.status = 'pendiente'
                             OR (a.ref_payco IS NOT NULL AND a.ref_payco !~ '^[0-9]{1,12}$')
                             OR (a.webhook_at IS NOT NULL AND COALESCE(a.webhook_summary->>'x_cod_response','') IN ('1','3','7','8'))))`;
  const kept = await query<{ id: string; local_number: string; approved: boolean }>(
    `UPDATE sales s SET status = 'pago_por_revisar', payment_status = 'por_confirmar',
            payment_failure_reason = CASE WHEN EXISTS (SELECT 1 FROM payment_attempts a WHERE a.sale_id = s.id AND a.webhook_approved_at IS NOT NULL AND a.status IN ('abierto','pendiente'))
                                          THEN '${APPROVED_WEBHOOK_REASON}'
                                          ELSE 'El cobro venció con un pago en proceso que ePayco aún no confirma. El sistema lo sigue consultando; si se confirma, se factura solo.' END
      WHERE s.status = 'esperando_pago' AND s.payment_expires_at IS NOT NULL AND s.payment_expires_at < now()
        AND ($1::uuid IS NULL OR s.id = $1) AND ${evidenceSql}
      RETURNING s.id, s.local_number, (s.payment_failure_reason = '${APPROVED_WEBHOOK_REASON}') AS approved`,
    [saleId ?? null]
  );
  for (const r of kept.rows) {
    await writeLog("pago", `Cobro ${r.local_number} venció CON evidencia de pago${r.approved ? " (aviso firmado de pago APROBADO)" : ""}: queda por revisar (no pago fallido) y se sigue consultando`, {
      level: "warn", detail: { sale_id: r.id, approved_webhook: r.approved },
    });
  }
  const { rows } = await query<{ id: string; local_number: string }>(
    `UPDATE sales s SET status = 'pago_fallido', payment_status = 'vencido',
            payment_failure_reason = 'Tiempo agotado: el pago no se confirmó en ${getEpaycoConfig().expiresMinutes} minutos'
      WHERE s.status = 'esperando_pago' AND s.payment_expires_at IS NOT NULL AND s.payment_expires_at < now()
        AND ($1::uuid IS NULL OR s.id = $1) AND NOT ${evidenceSql}
      RETURNING s.id, s.local_number`,
    [saleId ?? null]
  );
  if (rows.length) {
    await query("UPDATE payment_attempts SET status = 'vencido', closed_at = now() WHERE sale_id = ANY($1::uuid[]) AND status = 'abierto'", [rows.map((r) => r.id)]);
  }
  for (const r of rows) await writeLog("pago", `Cobro ${r.local_number} VENCIDO (tiempo agotado)`, { level: "warn", detail: { sale_id: r.id } });
  return rows.length + kept.rows.length;
}

/**
 * Llegó un aviso FIRMADO de pago APROBADO para una venta que ya estaba fallida/vencida (pago_fallido) y no se pudo confirmar con ePayco:
 * pasa a pago_tardio (no se factura sola; un admin decide). Guarda las referencias del aviso para reconocer el MISMO pago después.
 */
export async function markLateApprovedWebhook(saleId: string, s: { x_ref_payco: string; x_transaction_id: string }): Promise<boolean> {
  const moved = await transitionSale(saleId, ["pago_fallido"], "pago_tardio", {
    payment_status: "tardio",
    payment_reference: s.x_ref_payco || null,
    epayco_transaction_id: s.x_transaction_id || null,
    payment_failure_reason: `${APPROVED_WEBHOOK_REASON}, y llegó DESPUÉS de vencer el cobro. Un administrador decide (facturar o reembolsar).`,
  });
  return moved;
}
