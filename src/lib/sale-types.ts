// Tipos compartidos entre navegador y servidor para ventas y tirillas.

import type { PaymentMethod } from "./payments";
export { PAYMENT_METHODS, CASHIER_PAYMENT_METHODS, paymentLabel, requiresReference, type PaymentMethod } from "./payments";

export const CONSUMIDOR_FINAL_ID = "222222222222";

export const ID_TYPES = [
  { id: "13", label: "Cédula de ciudadanía" },
  { id: "31", label: "NIT" },
  { id: "22", label: "Cédula de extranjería" },
  { id: "41", label: "Pasaporte" },
] as const;

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

/** Lo que el navegador envía a POST /api/sales */
export type SaleIn = {
  id: string; // UUID generado en el navegador
  local_number: string; // C01-000123
  created_at_device: string; // ISO
  checkout_type: "corto" | "completo";
  payment_method: PaymentMethod;
  payment_reference: string | null; // obligatoria si el medio no es efectivo
  cash_received: number | null;
  customer: CustomerIn | null; // null = consumidor final
  items: SaleItemIn[];
};

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
  payment_method: string;
  payment_reference: string | null;
  cash_received: number | null;
  change_given: number | null;
  invoice_name: string | null;
  cufe: string | null;
};
