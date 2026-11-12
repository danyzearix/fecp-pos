// Forma de pago de Siigo para cada medio del POS. Para el pago electrónico (ePayco) el id sale de
// EPAYCO_SIIGO_PAYMENT_ID; el valor por defecto de src/config/siigo-map.ts solo vale en modo de pruebas.
import { EPAYCO_SIIGO_PAYMENT_ID_DEFAULT, SIIGO_PAYMENT_ID } from "@/config/siigo-map";
import type { PaymentMethod } from "../payments";

export const siigoTestMode = () => process.env.SIIGO_TEST_MODE === "true";
export const epaycoTestMode = () => process.env.EPAYCO_TEST_MODE === "true";

/** id explícito puesto en .env.local (número válido) o null */
function explicitEpaycoPaymentId(): number | null {
  const n = Number(process.env.EPAYCO_SIIGO_PAYMENT_ID);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function siigoPaymentId(method: PaymentMethod): number {
  if (method === "epayco") return explicitEpaycoPaymentId() ?? EPAYCO_SIIGO_PAYMENT_ID_DEFAULT;
  return SIIGO_PAYMENT_ID[method];
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
