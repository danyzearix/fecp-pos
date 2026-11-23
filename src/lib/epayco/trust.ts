// Aprobar un pago con el aviso FIRMADO de ePayco, sin poder consultarlo (la referencia larga nunca llegó). Lo usan, con EXACTAMENTE las
// mismas condiciones: (1) el botón del admin "Facturar con evidencia del webhook" y (2) la facturación AUTOMÁTICA, que está detrás de
// EPAYCO_TRUST_SIGNED_WEBHOOK=false (APAGADA por defecto).
//
// ⚠ La firma (x_signature) cubre solo cinco campos: x_ref_payco, x_transaction_id, x_amount, x_currency_code y el cliente. NO cubre el
// estado (x_cod_response), el invoice, x_extra1 ni x_test_request. Quien conozca P_KEY podría fabricar un aviso; y un aviso real de
// OTRA venta o de otro modo (prueba/real) llevaría una firma válida. Por eso aquí se exige, ADEMÁS de la firma, que TODO coincida con lo
// guardado en NUESTRA base de datos. Si una sola condición falla, no se aprueba nada (queda en "por revisar" para un admin).
//
// Es idempotente: pasa por processPayment (reclamo atómico del ref + una sola factura).
import type { NormalizedTx } from "./adapter";
import { getEpaycoConfig } from "./config";

export type TrustSale = { id: string; total: number };
export type TrustAttempt = { invoice: string; /** es el ÚLTIMO intento de la venta (no uno reemplazado por otro) */ current: boolean };

const num = (v: string | null | undefined) => (v === undefined || v === null || v.trim() === "" ? NaN : Number(v.trim()));

export type TrustResult = { ok: true; tx: NormalizedTx } | { ok: false; failed: string[] };

/**
 * `f` = campos del webhook (ya con la firma validada por quien llama). `sale` y `attempt` salen de la BASE DE DATOS, nunca del navegador.
 * Devuelve la transacción normalizada (para pasarla a processPayment) o la lista de condiciones que fallaron.
 */
export function evaluateTrustedWebhook(
  f: Record<string, string | null | undefined>,
  sale: TrustSale,
  attempt: TrustAttempt | null,
  o: { /** la firma del aviso se validó (al recibirlo) */ signatureVerified: boolean }
): TrustResult {
  const failed: string[] = [];
  const testMode = getEpaycoConfig().testMode;
  const cod = num(f.x_cod_response ?? f.x_cod_respuesta);
  const state = num(f.x_cod_transaction_state);
  const amount = num(f.x_amount);
  const currency = (f.x_currency_code ?? "").trim().toUpperCase();
  const t = (f.x_test_request ?? "").trim().toLowerCase();
  const test = t === "true" ? true : t === "false" ? false : null;
  const invoice = (f.x_id_invoice ?? f.x_id_factura ?? "").trim();
  const extra1 = (f.x_extra1 ?? "").trim();

  if (!o.signatureVerified) failed.push("no hay un aviso con firma válida");
  if (cod !== 1) failed.push("x_cod_response no es 1 (aceptada)");
  if (state !== 1) failed.push("x_cod_transaction_state no es 1");
  if (test === null) failed.push("falta x_test_request");
  else if (test !== testMode) failed.push("x_test_request no coincide con EPAYCO_TEST_MODE");
  if (currency !== "COP") failed.push("la moneda no es COP");
  if (!Number.isFinite(amount) || Math.abs(amount - sale.total) >= 0.005) failed.push("x_amount no es el total de la venta guardada");
  if (!attempt || !invoice || invoice !== attempt.invoice || !attempt.current) failed.push("x_id_invoice no es la referencia del intento vigente");
  if (!extra1 || extra1 !== sale.id) failed.push("x_extra1 no es el id de la venta");
  if (!f.x_ref_payco || !f.x_transaction_id) failed.push("faltan x_ref_payco o x_transaction_id");
  if (failed.length) return { ok: false, failed };

  return {
    ok: true,
    tx: {
      refPayco: f.x_ref_payco!,
      transactionId: f.x_transaction_id!,
      invoice,
      amountRaw: f.x_amount!,
      amount,
      currency,
      codResponse: 1,
      response: (f.x_response ?? f.x_respuesta ?? "").trim() || null,
      testRequest: test,
      signature: f.x_signature ?? null, // el resumen guardado no trae la firma: ya se validó al recibir el aviso
      approvalCode: f.x_approval_code?.trim() || null,
      franchise: f.x_franchise?.trim() || null,
      extra1,
    },
  };
}
