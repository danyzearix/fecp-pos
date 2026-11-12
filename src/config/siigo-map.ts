// Configuración de Siigo editable (ids tomados de GET /v1/taxes, /v1/payment-types?document_type=FV y
// /v1/cost-centers el 2026-11-11). Se pueden volver a consultar en /api/admin/siigo/taxes y /api/admin/siigo/payment-types.
import type { PaymentMethod } from "@/lib/payments";

/** Productos GRAVADOS: tarifa → id del impuesto IVA en Siigo */
export const SIIGO_TAX_ID_BY_RATE: Record<number, number> = {
  19: 2785, // IVA 19%
  5: 2786, // IVA 5%
};

/** Productos EXENTOS (0 %): se envía este impuesto. */
export const SIIGO_EXEMPT_TAX_ID = 26387; // IVA 0%

/** Productos EXCLUIDOS: se envían SIN arreglo taxes (igual que la factura FV-2-31341). */

/** Medio de pago del POS → id de forma de pago en Siigo */
export const SIIGO_PAYMENT_ID: Record<PaymentMethod, number> = {
  efectivo: 1666, // Efectivo
  tarjeta_debito: 1669, // Tarjeta Crédito — cambiar cuando FECP cree "Tarjeta Débito" en Siigo
  tarjeta_credito: 1669, // Tarjeta Crédito
  transferencia: 5798, // Pago transferencia Bancol
  // Pago electrónico (ePayco, kiosco). Valor SOLO DE PRUEBAS: en modo real se exige EPAYCO_SIIGO_PAYMENT_ID en .env.local
  // (ver src/lib/siigo/payment.ts). Aquí queda el valor por defecto para SIIGO_TEST_MODE=true.
  epayco: 5798,
  // Para agregar Nequi como medio aparte: añadirlo en src/lib/payments.ts y aquí con su id de Siigo.
};

/** Valor de prueba para el pago electrónico; el definitivo se pone en EPAYCO_SIIGO_PAYMENT_ID */
export const EPAYCO_SIIGO_PAYMENT_ID_DEFAULT = 5798;

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
