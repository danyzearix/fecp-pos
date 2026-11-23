import { after, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { ATTEMPT_COLS, candidatesOf, markWebhook, REF_KIND_TEXT, webhookSummary, type Attempt, type RefCandidate } from "@/lib/epayco/attempts";
import { expectedSignature, EpaycoError, isShortRef, signatureMatches } from "@/lib/epayco/adapter";
import { triedText, verifyByCandidates } from "@/lib/epayco/candidates";
import { getEpaycoConfig, publicModeEnabled } from "@/lib/epayco/config";
import { markLateApprovedWebhook, PaymentInputError, processPayment, recordWebhookHint, type PaymentResult } from "@/lib/epayco/process";
import { evaluateTrustedWebhook } from "@/lib/epayco/trust";
import { writeLog } from "@/lib/log";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 60;

/**
 * WEBHOOK de confirmación de ePayco (servidor a servidor). APAGADO mientras APP_PUBLIC_URL esté vacío (modo local).
 *  - Exige x_signature válida (SHA-256 con P_CUST_ID_CLIENTE y P_KEY).
 *  - Aun con firma válida NO confía en el contenido: la firma NO cubre el estado, el invoice ni el modo de prueba. Por eso ubica la
 *    venta por x_id_invoice, EXIGE que x_extra1 (el UUID de la venta) coincida si viene, y CONFIRMA consultando a ePayco.
 *  - La consulta de ePayco solo funciona con la referencia LARGA (ref_payco, 24 hex). El webhook NO la trae (x_ref_payco es el número corto y
 *    x_transaction_id es del procesador; comprobado con pagos reales el 2026-11-23). La larga llega por el NAVEGADOR (hooks del checkout o la
 *    URL de retorno /pagar/<código>/retorno?ref_payco=...). Si ya se conoce, se consulta aquí mismo.
 *  - Se guarda en el intento un resumen del aviso (referencias, invoice, extra1, monto, moneda, estado, franquicia, modo, fechas; sin firma ni
 *    datos personales). Cuenta como EVIDENCIA de pago y, si dice APROBADO, el cobro ya no puede vencer como fallido (ver expireWaitingPayments).
 *  - Sin poder confirmar: EPAYCO_TRUST_SIGNED_WEBHOOK=true (APAGADA por defecto) aprueba con el aviso firmado si se cumplen TODAS las
 *    condiciones de trust.ts; si no, queda como evidencia para el retorno, la consulta activa o el admin ("Facturar con evidencia del webhook").
 *  - EPAYCO_ALT_REF_LOOKUP=true (APAGADA por defecto, experimental) prueba además consultar con x_transaction_id y x_ref_payco.
 *  - Si la consulta falló por algo pasajero (red, error de ePayco), responde 500 para que ePayco REINTENTE.
 *  - Idempotente: ePayco puede reintentar; cada referencia se procesa una sola vez y la factura sale una sola vez.
 *  - Responde 200 rápido y sin redirecciones (requisito de ePayco); la facturación corre después.
 */
async function handle(req: Request) {
  if (!publicModeEnabled()) return new NextResponse(null, { status: 404 });

  // Los datos pueden llegar por GET (query) o POST (form o JSON)
  const url = new URL(req.url);
  const f: Record<string, string> = Object.fromEntries(url.searchParams.entries());
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/json")) {
        const j = await req.json();
        if (j && typeof j === "object") for (const [k, v] of Object.entries(j)) if (typeof v === "string" || typeof v === "number") f[k] = String(v);
      } else {
        for (const [k, v] of (await req.formData()).entries()) if (typeof v === "string") f[k] = v;
      }
    } catch {
      return new NextResponse("Cuerpo inválido", { status: 400 });
    }
  }

  const ref = f.x_ref_payco ?? ""; // número corto: entra en la firma
  const txId = f.x_transaction_id ?? "";
  const amount = f.x_amount ?? "";
  const currency = f.x_currency_code ?? "";
  const sig = f.x_signature ?? "";
  const invoice = f.x_id_invoice ?? f.x_id_factura ?? "";
  const extra1 = (f.x_extra1 ?? "").trim();
  // Por si algún día el aviso trae la referencia LARGA (no pasa hoy): solo se toma si NO es un número corto
  const longFromHook = [f.ref_payco].map((v) => (v ?? "").trim()).find((v) => v && !isShortRef(v) && !/^\d+$/.test(v)) ?? "";
  // Se registra lo mínimo (nunca la firma, llaves ni datos personales). "fields" son solo los NOMBRES de los campos recibidos.
  const seen = {
    ref_payco: ref,
    transaction_id: txId,
    invoice,
    amount,
    response: f.x_response ?? f.x_respuesta ?? null,
    cod_response: f.x_cod_response ?? f.x_cod_respuesta ?? null,
    franchise: f.x_franchise ?? null,
    test: f.x_test_request ?? null,
    has_long_ref: !!longFromHook,
    fields: Object.keys(f).filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 80),
  };

  if (!ref || !txId || !amount || !currency || !sig || !invoice) {
    await writeLog("pago", "Webhook ePayco con campos incompletos", { level: "warn", detail: seen });
    return new NextResponse("Campos incompletos", { status: 400 });
  }

  let valid = false;
  try {
    valid = signatureMatches(sig, expectedSignature({ ref, transactionId: txId, amountRaw: amount, currency }));
  } catch (e) {
    await writeLog("pago", `Webhook ePayco no se pudo validar: ${e instanceof EpaycoError ? e.message : "error"}`, { level: "error", detail: seen });
    return new NextResponse("Configuración incompleta", { status: 500 }); // ePayco reintentará
  }
  if (!valid) {
    await writeLog("pago", "Webhook ePayco con FIRMA INVÁLIDA (rechazado)", { level: "error", detail: seen });
    return new NextResponse("Firma inválida", { status: 400 });
  }

  const sale = await query<{ id: string; total: number; status: string; payment_reference: string | null; epayco_transaction_id: string | null }>(
    `SELECT s.id, s.total::float8 AS total, s.status, s.payment_reference, s.epayco_transaction_id FROM sales s
      WHERE s.source IN ('kiosco','caja') AND s.payment_method = 'epayco'
        AND (s.local_number = $1 OR EXISTS (SELECT 1 FROM payment_attempts a WHERE a.sale_id = s.id AND a.invoice = $1))
      LIMIT 1`,
    [invoice]
  );
  if (!sale.rows[0]) {
    await writeLog("pago", `Webhook ePayco para un invoice desconocido (${invoice})`, { level: "warn", detail: seen });
    return new NextResponse("OK", { status: 200 }); // 200 para que no reintente eternamente
  }
  const { id: saleId, total, status: saleStatus, payment_reference: paidRef, epayco_transaction_id: paidTx } = sale.rows[0];
  // x_extra1 es el UUID de NUESTRA venta (lo mandamos al crear la sesión). Si viene y no coincide con la venta que ubicó el invoice, el aviso
  // NO se procesa (ni cuenta como evidencia): se registra y se responde 200 (reintentar no cambiaría nada).
  if (extra1 && extra1 !== saleId) {
    await writeLog("pago", `Webhook ePayco RECHAZADO: x_extra1 no corresponde a la venta de ${invoice} (no se procesó)`, { level: "error", detail: { sale_id: saleId, ...seen } });
    return new NextResponse("OK", { status: 200 });
  }

  const summary = webhookSummary(f);
  const approvedHook = summary.x_cod_response === "1";

  // Venta que ya se cobró (pagada o facturada): el aviso es un reintento del webhook (o llegó después del navegador). Solo se anota.
  if (!longFromHook && ["pagado", "invoicing", "invoiced", "pending", "failed", "revisar"].includes(saleStatus)) {
    await markWebhook(invoice, summary).catch(() => {});
    // ¿Es el MISMO pago ya registrado? Si trae otra referencia y otro número de transacción, puede ser un SEGUNDO cobro (log de nivel error)
    const same = (paidRef && paidRef === ref) || (paidTx && paidTx === txId);
    await writeLog(
      "pago",
      same
        ? `Webhook ePayco de ${invoice}: la venta ya estaba pagada (${saleStatus}) con este mismo pago; no hay nada que procesar`
        : `Webhook ePayco de ${invoice}: la venta ya estaba pagada (${saleStatus}) y el aviso trae OTRA referencia (${ref}). Si es un pago aprobado, puede ser un SEGUNDO cobro: verifíquelo en el panel de ePayco`,
      { level: same || !approvedHook ? "info" : "error", detail: { sale_id: saleId, ...seen } }
    );
    return new NextResponse("OK", { status: 200 });
  }
  const att = (await query<Attempt>(`SELECT ${ATTEMPT_COLS} FROM payment_attempts WHERE sale_id = $1 AND invoice = $2`, [saleId, invoice])).rows[0] ?? null;

  // Evidencia + referencias + resumen del aviso, en el intento. Con x_cod_response=1 el cobro ya NO puede vencer como fallido.
  await markWebhook(invoice, summary).catch(() => {});
  await writeLog("pago", `Webhook ePayco recibido para ${invoice}`, { detail: { sale_id: saleId, ...seen } });

  // Referencias para CONSULTAR a ePayco: la larga (si el navegador ya la entregó) y, solo con EPAYCO_ALT_REF_LOOKUP=true, las del aviso.
  const cands: RefCandidate[] = [];
  const addC = (c: RefCandidate) => {
    if (/^[A-Za-z0-9_-]{4,64}$/.test(c.ref) && !cands.some((x) => x.ref === c.ref)) cands.push(c);
  };
  if (longFromHook) addC({ ref: longFromHook, kind: "larga" });
  for (const c of att ? candidatesOf(att) : []) addC(c);
  if (getEpaycoConfig().altRefLookup) {
    addC({ ref: txId, kind: "transaction_id" });
    addC({ ref, kind: "corta" });
  }
  const first = att?.ref_used ? cands.findIndex((c) => c.kind === att.ref_used) : -1;
  if (first > 0) cands.unshift(...cands.splice(first, 1));

  try {
    const run = await verifyByCandidates(saleId, cands, "webhook");
    let r: PaymentResult | null = run;
    if (run && run.outcome !== "no_verificado") {
      await writeLog("pago", `Webhook de ${invoice}: ePayco confirmó la transacción con ${REF_KIND_TEXT[run.used ?? "larga"]} → ${run.outcome}`, {
        detail: { sale_id: saleId, ref_used: run.used, tried: run.tried, outcome: run.outcome },
      });
    } else {
      // No se pudo CONFIRMAR con ePayco: no había referencia larga (lo normal en PSE por QR) o ePayco no la reconoció / no respondió.
      const summaryText = run ? triedText(run.tried) : "todavía no hay referencia larga para consultar";
      // Pasajero (red / HTTP) o una referencia LARGA que ePayco todavía no encuentra: 500 para que ePayco reintente (nada se consumió)
      if (run && (run.transient || run.tried.some((t) => t.kind === "larga" && !t.resolved))) {
        await writeLog("pago", `Webhook de ${invoice}: la consulta a ePayco falló por algo pasajero (${summaryText}); se pide reintento`, {
          level: "warn", detail: { sale_id: saleId, tried: run.tried },
        });
        return new NextResponse("Verificación pendiente", { status: 500 });
      }
      const trustOn = getEpaycoConfig().trustSignedWebhook;
      const lastNo = (await query<{ n: number }>("SELECT max(attempt_no)::int AS n FROM payment_attempts WHERE sale_id = $1", [saleId])).rows[0]?.n ?? 0;
      const ev = approvedHook ? evaluateTrustedWebhook(f, { id: saleId, total }, att ? { invoice: att.invoice, current: att.attempt_no === lastNo } : null, { signatureVerified: true }) : null;
      if (trustOn && ev?.ok) {
        r = await processPayment(saleId, ref, "webhook", { kind: "corta", trusted: ev.tx });
        await writeLog("pago", `Webhook de ${invoice} aceptado por su FIRMA (EPAYCO_TRUST_SIGNED_WEBHOOK=true), sin consultar a ePayco (${summaryText}) → ${r.outcome}`, {
          level: "warn", detail: { sale_id: saleId, tried: run?.tried ?? [], outcome: r.outcome },
        });
      } else {
        // Sin decidir: el aviso queda como EVIDENCIA. Si la venta ya estaba fallida/vencida y el aviso dice APROBADO → pago_tardio.
        const late = approvedHook && saleStatus === "pago_fallido" ? await markLateApprovedWebhook(saleId, summary) : false;
        const hinted = await recordWebhookHint({ saleId, ref, txId, amountRaw: amount });
        const failedTrust = trustOn && ev && !ev.ok ? ev.failed : null;
        const state = approvedHook ? "APROBADO" : `código ${summary.x_cod_response ?? "?"}`;
        await writeLog(
          "pago",
          `Webhook firmado de ${invoice} (${state}) sin poder confirmarlo con ePayco (${summaryText})` +
            (failedTrust ? ` (EPAYCO_TRUST_SIGNED_WEBHOOK=true, pero falla: ${failedTrust.join("; ")})` : "") +
            (late ? ". La venta estaba vencida: pasa a pago tardío" : "") +
            ". Queda como evidencia: se confirma con el retorno del navegador, la consulta activa o Admin → Pagos por revisar",
          { level: "warn", detail: { sale_id: saleId, hinted, late, tried: run?.tried ?? [], trust: trustOn, ...(failedTrust ? { failed: failedTrust } : {}), ...seen } }
        );
        return new NextResponse("OK", { status: 200 }); // reintentar no ayudaría
      }
    }
    if (r?.startInvoicing) {
      after(() => invoiceSale(saleId).catch((e) => writeLog("factura", `Error facturando pago electrónico: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: saleId } })));
    }
  } catch (e) {
    if (e instanceof PaymentInputError) return new NextResponse("OK", { status: 200 });
    await writeLog("pago", `Error procesando webhook: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: saleId, ref_payco: ref } });
    return new NextResponse("Error", { status: 500 }); // ePayco reintentará
  }
  return new NextResponse("OK", { status: 200 });
}

export const GET = handle;
export const POST = handle;
