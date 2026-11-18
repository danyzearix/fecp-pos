// Reglas puras de la retención por "precio por revisar" (las usan el servidor y las pantallas).
/** Una venta retenida se marca ATRASADA a las 2 horas y en ROJO (crítica) a las 4. */
export const REVIEW_LATE_MIN = 120;
export const REVIEW_CRITICAL_MIN = 240;
export type AgeLevel = "ok" | "atrasada" | "critica";
export const ageLevel = (minutes: number): AgeLevel => (minutes >= REVIEW_CRITICAL_MIN ? "critica" : minutes >= REVIEW_LATE_MIN ? "atrasada" : "ok");

/** "2 h 05 min" / "35 min" */
export function heldText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}

export type ReviewReason = "precio" | "iva" | "sku" | "producto_desconocido";
export const REASON_LABEL: Record<ReviewReason, string> = {
  precio: "Precio distinto",
  iva: "IVA distinto",
  sku: "SKU distinto",
  producto_desconocido: "Producto desconocido",
};

/** Una línea de la venta contra lo vigente. Se guarda tal cual en sales.price_review_detail. */
export type ReviewLine = {
  product_id: number | null;
  name: string;
  quantity: number;
  sku_sent: string;
  sku_now: string | null;
  price_sent: number;
  price_now: number | null;
  tax_sent: number;
  tax_now: number | null;
  incl_sent: boolean;
  incl_now: boolean | null;
  /** (enviado − vigente) por unidad y por línea; null si el producto no existe */
  diff_unit: number | null;
  diff_line: number | null;
  reasons: ReviewReason[];
};

export type ReviewDetail = {
  lines: ReviewLine[];
  reasons: ReviewReason[];
  window_hours: number;
  /** suma de las diferencias de las líneas (precio enviado − vigente), en pesos */
  diff_total: number;
};
