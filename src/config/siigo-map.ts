// Configuración de Siigo editable (ids tomados de GET /v1/taxes, /v1/payment-types?document_type=FV y
// /v1/cost-centers el 2026-11-11). Se pueden volver a consultar en /api/admin/siigo/taxes y /api/admin/siigo/payment-types.
import type { LineMethod } from "@/lib/payments";

/** Productos GRAVADOS: tarifa → id del impuesto IVA en Siigo */
export const SIIGO_TAX_ID_BY_RATE: Record<number, number> = {
  19: 2785, // IVA 19%
  5: 2786, // IVA 5%
};

/** Productos EXENTOS (0 %): se envía este impuesto. */
export const SIIGO_EXEMPT_TAX_ID = 26387; // IVA 0%

/** Productos EXCLUIDOS: se envían SIN arreglo taxes (igual que la factura FV-2-31341). */

/**
 * Medio de pago de UNA LÍNEA del POS → id de forma de pago en Siigo (GET /v1/payment-types?document_type=FV).
 * Se envía un pago por cada línea de sale_payments.
 */
export const SIIGO_PAYMENT_ID: Record<LineMethod, number> = {
  efectivo: 1666, // Efectivo
  tarjeta: 1669, // Tarjeta Crédito (reemplaza a Tarjeta débito y Tarjeta crédito; ambos ya iban al 1669)
  tarjeta_debito: 1669, // histórico: ventas viejas
  tarjeta_credito: 1669, // histórico: ventas viejas
  transferencia: 5798, // Pago transferencia Bancol — VALOR DE PRUEBAS, pendiente de confirmar con FECP
  // Crédito FECP: el id REAL se pone en SIIGO_PAYMENT_CREDITO_ID (.env). Este valor es solo el de PRUEBAS (SIIGO_TEST_MODE=true):
  // 1667 "Crédito" es la forma de pago de Siigo con fecha de vencimiento (due_date=true). Con SIIGO_TEST_MODE=false y la
  // variable vacía, el sistema se niega a facturar ventas con crédito (ver src/lib/siigo/payment.ts).
  credito_fecp: 1667,
  // Pago electrónico (ePayco, kiosco). Valor SOLO DE PRUEBAS: en modo real se exige EPAYCO_SIIGO_PAYMENT_ID en .env.local
  // (ver src/lib/siigo/payment.ts). Aquí queda el valor por defecto para SIIGO_TEST_MODE=true.
  epayco: 5798,
  // Para agregar Nequi como medio aparte: añadirlo en src/lib/payments.ts y aquí con su id de Siigo.
};

/** Valor de prueba para el pago electrónico; el definitivo se pone en EPAYCO_SIIGO_PAYMENT_ID */
export const EPAYCO_SIIGO_PAYMENT_ID_DEFAULT = 5798;

/** Valor de prueba para el Crédito FECP; el definitivo se pone en SIIGO_PAYMENT_CREDITO_ID */
export const CREDITO_SIIGO_PAYMENT_ID_DEFAULT = SIIGO_PAYMENT_ID.credito_fecp;

/** Centro de costo obligatorio en los documentos 35123 y 6503 */
export const SIIGO_COST_CENTER = 972; // VENTAS

/** Responsabilidad fiscal al crear clientes nuevos en Siigo */
export const SIIGO_DEFAULT_FISCAL_RESPONSIBILITY = "R-99-PN"; // No aplica - Otros

/** Tiempos */
export const SIIGO_INVOICE_TIMEOUT_MS = 120_000; // creación de factura (recomendado por Siigo)
export const SIIGO_DEFAULT_TIMEOUT_MS = 30_000; // consultas
export const SIIGO_POLL_INTERVAL_MS = 2_000; // consulta de estado DIAN
export const SIIGO_POLL_ATTEMPTS = 5;
export const SIIGO_MAX_REQUESTS_PER_MINUTE = 90; // límite de Siigo: 100/min por empresa (dejamos margen)

/**
 * Sincronización de clientes Siigo → POS (src/lib/siigo/customer-sync.ts). SOLO LEE (GET /v1/customers).
 * Máximo de peticiones por minuto de la sincronización (el límite de Siigo es 100 por minuto para TODA la empresa y el cliente
 * del POS ya limita todo a SIIGO_MAX_REQUESTS_PER_MINUTE). Con 40 por minuto, ~17.000 clientes (170 páginas de 100) tardan ~4,5 min.
 */
export const SIIGO_CUSTOMER_SYNC_PER_MINUTE = 40;
/** Prioridad baja: si en el último minuto ya van más de estas peticiones (por ejemplo, por facturación), la sincronización espera. */
export const SIIGO_CUSTOMER_SYNC_YIELD_ABOVE = 60;
/** Consulta de cliente en vivo (caja y kiosco): si ya van estas peticiones en el último minuto, no se consulta (límite de Siigo: 100/min). */
export const SIIGO_LIVE_LOOKUP_MAX_PER_MINUTE = 80;
