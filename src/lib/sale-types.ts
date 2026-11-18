// Tipos compartidos entre navegador y servidor para ventas y tirillas.

import type { LineMethod, PaymentMethod } from "./payments";
import type { PayLine, PayLineIn } from "./payment-lines";
export {
  PAYMENT_METHODS, LEGACY_PAYMENT_METHODS, CASHIER_PAYMENT_METHODS, paymentLabel, paymentShortLabel, requiresReference,
  type LineMethod, type PaymentMethod,
} from "./payments";
export type { PayLine, PayLineIn } from "./payment-lines";

export const CONSUMIDOR_FINAL_ID = "222222222222";

export const ID_TYPES = [
  { id: "13", label: "Cédula de ciudadanía" },
  { id: "31", label: "NIT" },
  { id: "22", label: "Cédula de extranjería" },
  { id: "41", label: "Pasaporte" },
] as const;

/**
 * Tipos de documento que puede traer un cliente SINCRONIZADO desde Siigo (tabla de la DIAN). La caja los acepta para clientes
 * que ya existen; los formularios (caja y kiosco) siguen ofreciendo solo los de ID_TYPES al registrar un cliente nuevo.
 */
export const ID_TYPE_LABELS: Record<string, string> = {
  "11": "Registro civil",
  "12": "Tarjeta de identidad",
  "13": "Cédula de ciudadanía",
  "21": "Tarjeta de extranjería",
  "22": "Cédula de extranjería",
  "31": "NIT",
  "41": "Pasaporte",
  "42": "Documento de identificación extranjero",
  "43": "Sin identificación del exterior",
  "47": "PEP",
  "48": "PPT",
  "50": "NIT de otro país",
  "91": "NUIP",
};

export type CustomerIn = {
  id_type: string;
  identification: string;
  check_digit?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  company_name?: string | null;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
  state_code?: string | null;
  city_code?: string | null;
};

export type SaleItemIn = {
  product_id: number;
  sku: string;
  name: string;
  quantity: number;
  unit_price: number;
  tax_rate: number;
  prices_include_tax: boolean;
};

/**
 * Lo que el navegador envía a POST /api/sales.
 * FORMATO NUEVO: `payments` (1 a 4 líneas, una por medio). FORMATO VIEJO (ventas que quedaron en la cola local antes de esta
 * versión): payment_method / payment_reference / cash_received, un solo medio por el total. El servidor acepta los dos.
 */
export type SaleIn = {
  id: string; // UUID generado en el navegador
  local_number: string; // C01-000123
  created_at_device: string; // ISO
  checkout_type: "corto" | "completo";
  customer: CustomerIn | null; // null = consumidor final
  items: SaleItemIn[];
  /** formato nuevo: líneas de pago (los montos aplicados deben sumar el total que calcula el servidor) */
  payments?: PayLineIn[];
  /** formato viejo (solo para ventas ya encoladas): */
  payment_method?: LineMethod;
  payment_reference?: string | null;
  cash_received?: number | null;
};

/** Una línea de pago tal como se muestra en la tirilla, el historial y los reportes */
export type PaymentLineView = PayLine;

/** Configuración no secreta que necesitan la caja y la tirilla */
export type PosConfig = {
  prefix: string;
  uvt: number;
  testMode: boolean;
  defaultStateCode: string;
  defaultCityCode: string;
  negocio: { nombre: string; nit: string; direccion: string; telefono: string };
  software: { nombre: string; fabricante: string };
  /** Resolución DIAN de facturación (Siigo no la entrega por API: viene del .env) */
  resolucion: { numero: string; fecha: string; rango: string; vigencia: string };
};

/** Todo lo necesario para dibujar una tirilla */
export type TicketData = {
  id: string;
  local_number: string;
  status: string;
  created_at: string; // ISO
  cashier_name: string;
  customer_name: string;
  customer_identification: string;
  items: { name: string; quantity: number; unit_price: number; line_total: number; tax_rate: number }[];
  subtotal: number;
  tax_total: number;
  total: number;
  tax_by_rate: { rate: number; base: number; tax: number }[];
  /** columnas viejas (compatibilidad): medio de la venta ("mixto" si hay varias líneas), referencias, efectivo */
  payment_method: string;
  payment_reference: string | null;
  cash_received: number | null;
  change_given: number | null;
  /** una entrada por línea de pago (sale_payments). Es lo que imprime la tirilla. */
  payments: PaymentLineView[];
  invoice_name: string | null;
  cufe: string | null;
};

export type { PaymentMethod as SalePaymentMethod };
