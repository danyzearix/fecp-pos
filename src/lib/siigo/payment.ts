// Forma de pago de Siigo para cada medio del POS. Para el pago electrónico (ePayco) el id sale de
// EPAYCO_SIIGO_PAYMENT_ID; el valor por defecto de src/config/siigo-map.ts solo vale en modo de pruebas.
import { CREDITO_SIIGO_PAYMENT_ID_DEFAULT, EPAYCO_SIIGO_PAYMENT_ID_DEFAULT, SIIGO_PAYMENT_ID } from "@/config/siigo-map";
import type { LineMethod } from "../payments";

export const siigoTestMode = () => process.env.SIIGO_TEST_MODE === "true";
export const epaycoTestMode = () => process.env.EPAYCO_TEST_MODE === "true";

/** id explícito puesto en .env.local (número válido) o null */
function explicitEpaycoPaymentId(): number | null {
  const n = Number(process.env.EPAYCO_SIIGO_PAYMENT_ID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** id explícito del Crédito FECP puesto en .env (SIIGO_PAYMENT_CREDITO_ID) o null */
export function explicitCreditPaymentId(): number | null {
  const n = Number(process.env.SIIGO_PAYMENT_CREDITO_ID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Forma de pago de Siigo de UNA línea de pago */
export function siigoPaymentId(method: LineMethod): number {
  if (method === "epayco") return explicitEpaycoPaymentId() ?? EPAYCO_SIIGO_PAYMENT_ID_DEFAULT;
  if (method === "credito_fecp") return explicitCreditPaymentId() ?? CREDITO_SIIGO_PAYMENT_ID_DEFAULT;
  return SIIGO_PAYMENT_ID[method];
}

/**
 * ¿Se puede facturar una venta con Crédito FECP? Devuelve el motivo si NO, o null si sí.
 *  - Modo real de Siigo sin SIIGO_PAYMENT_CREDITO_ID → no (el id por defecto es solo de pruebas).
 */
export function creditInvoicingBlocker(): string | null {
  if (!siigoTestMode() && explicitCreditPaymentId() === null) {
    return "Falta SIIGO_PAYMENT_CREDITO_ID en .env.production: en modo real no se factura con el id de pruebas del Crédito FECP.";
  }
  return null;
}

/**
 * ¿Se puede facturar un pago electrónico? Devuelve el motivo si NO, o null si sí.
 *  - Modo real de Siigo sin EPAYCO_SIIGO_PAYMENT_ID explícito → no (el id por defecto es solo de pruebas).
 *  - Pago de PRUEBA de ePayco con Siigo en modo REAL → no (una factura real por un pago que no movió dinero).
 */
export function epaycoInvoicingBlocker(): string | null {
  if (!siigoTestMode() && explicitEpaycoPaymentId() === null) {
    return "Falta EPAYCO_SIIGO_PAYMENT_ID en .env.local: en modo real no se factura con el id de pruebas.";
  }
  if (epaycoTestMode() && !siigoTestMode()) {
    return "EPAYCO_TEST_MODE=true con SIIGO_TEST_MODE=false: no se factura (real) un pago de prueba.";
  }
  return null;
}
