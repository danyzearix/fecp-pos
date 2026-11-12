// Mapeo de impuestos WooCommerce → tarifa de IVA en Colombia.
// Edita este archivo si tu tienda usa otras clases de impuesto.

export type TaxRate = 0 | 5 | 19;

/** tax_class de Woo (slug) → tarifa. '' es la clase "Estándar". */
export const TAX_CLASS_RATES: Record<string, TaxRate> = {
  "": 19,
  "reduced-rate": 5,
  "zero-rate": 0,
  "tasa-cero": 0, // clase propia de la tienda FECP (detectada en la primera sincronización)
};

/** Si la clase no está en el mapa se usa esta tarifa (y se avisa en el resultado del sync). */
export const DEFAULT_TAX_RATE: TaxRate = 19;

/**
 * tax_status de Woo que significan "este producto no paga IVA".
 * 'none' = no sujeto. 'shipping' = solo el envío paga impuesto (el producto no).
 */
export const TAX_STATUS_EXEMPT = ["none", "shipping"];

/** Claves de meta_data donde algunos plugins guardan el código de barras (en orden de prioridad). */
export const BARCODE_META_KEYS = [
  "_global_unique_id",
  "_barcode",
  "barcode",
  "_ean",
  "ean",
  "_gtin",
  "_upc",
  "_wpm_gtin_code",
  "hwp_product_gtin",
];
