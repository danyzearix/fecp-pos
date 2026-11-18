// Validación de PRECIOS de las ventas de la caja, en el servidor.
//
// Por qué: la caja arma la venta con el catálogo guardado en el equipo (así funciona sin conexión) y manda precio, IVA y SKU.
// Antes el servidor los aceptaba tal cual: un navegador alterado podía vender un producto de $12.600 por $1.
// (El kiosco y el cobro electrónico NO tienen este problema: solo mandan product_id y cantidad y el precio sale de la base.)
//
// Regla (tolerancia CERO): una línea es válida si su precio, IVA (tax_rate y prices_include_tax) y SKU coinciden con los
// vigentes, o con alguna versión que haya estado vigente en las últimas PRICE_HISTORY_HOURS horas (72 por defecto): así una
// venta hecha sin conexión con un precio que luego cambió no genera falsas alarmas.
// Si algo no coincide (o el producto no existe) la venta NO se rechaza —el cliente ya pagó—: se acepta, se guarda y queda
// RETENIDA (no se factura sola) hasta que un admin la apruebe o la anule.
import { query } from "./db";
import type { ReviewDetail, ReviewLine, ReviewReason } from "./price-review-rules";
import type { SaleItemIn } from "./sale-types";

/** Ventana del historial en horas: PRICE_HISTORY_HOURS (por defecto 72). */
export function priceHistoryHours(): number {
  const n = Number(process.env.PRICE_HISTORY_HOURS);
  return Number.isFinite(n) && n > 0 ? n : 72;
}

type Version = { product_id: number; sku: string | null; price: number; tax_rate: number; prices_include_tax: boolean };
const cents = (n: number) => Math.round(n * 100);
const sameVersion = (v: Version, i: SaleItemIn) =>
  (v.sku ?? "") === i.sku && cents(v.price) === cents(i.unit_price) && v.tax_rate === i.tax_rate && v.prices_include_tax === i.prices_include_tax;

export type PriceCheck = { flagged: boolean; detail: ReviewDetail; summary: string };

/** Compara cada línea con la base. No escribe nada. */
export async function checkPrices(items: SaleItemIn[]): Promise<PriceCheck> {
  const hours = priceHistoryHours();
  const ids = [...new Set(items.map((i) => i.product_id).filter((n) => Number.isInteger(n) && n > 0))];

  const current = new Map<number, Version>();
  const history = new Map<number, Version[]>();
  if (ids.length) {
    const cur = await query<Version>(
      "SELECT id AS product_id, sku, price::float8 AS price, tax_rate, prices_include_tax FROM products WHERE id = ANY($1::int[])",
      [ids]
    );
    for (const r of cur.rows) current.set(r.product_id, r);
    // Versiones vigentes en algún momento de las últimas N horas (incluida la vigente ahora)
    const h = await query<Version>(
      `SELECT product_id, sku, price::float8 AS price, tax_rate, prices_include_tax
         FROM product_price_history
        WHERE product_id = ANY($1::int[]) AND valid_from <= now()
          AND (valid_to IS NULL OR valid_to >= now() - make_interval(hours => $2))`,
      [ids, hours]
    );
    for (const r of h.rows) history.set(r.product_id, [...(history.get(r.product_id) ?? []), r]);
  }

  const lines: ReviewLine[] = items.map((i) => {
    const base = { name: i.name, quantity: i.quantity, sku_sent: i.sku, price_sent: i.unit_price, tax_sent: i.tax_rate, incl_sent: i.prices_include_tax };
    const cur = Number.isInteger(i.product_id) ? current.get(i.product_id) : undefined;
    if (!cur) {
      // El producto no existe (o no viene): se acepta igual, marcado "producto desconocido"
      return {
        ...base, product_id: Number.isInteger(i.product_id) ? i.product_id : null, sku_now: null, price_now: null, tax_now: null, incl_now: null,
        diff_unit: null, diff_line: null, reasons: ["producto_desconocido"] as ReviewReason[],
      };
    }
    // Sin historial para este producto (no debería pasar tras db:setup): se compara solo con lo vigente
    const candidates = history.get(cur.product_id)?.length ? history.get(cur.product_id)! : [cur];
    const ok = candidates.some((v) => sameVersion(v, i));
    const reasons: ReviewReason[] = [];
    if (!ok) {
      if (cents(cur.price) !== cents(i.unit_price)) reasons.push("precio");
      if (cur.tax_rate !== i.tax_rate || cur.prices_include_tax !== i.prices_include_tax) reasons.push("iva");
      if ((cur.sku ?? "") !== i.sku) reasons.push("sku");
      // Coincide con lo vigente en todo pero no con el historial (no debería ocurrir): se marca como precio
      if (!reasons.length) reasons.push("precio");
    }
    const diffUnit = Math.round((i.unit_price - cur.price) * 100) / 100;
    return {
      ...base, product_id: cur.product_id, sku_now: cur.sku, price_now: cur.price, tax_now: cur.tax_rate, incl_now: cur.prices_include_tax,
      diff_unit: ok ? 0 : diffUnit, diff_line: ok ? 0 : Math.round(diffUnit * i.quantity * 100) / 100, reasons,
    };
  });

  const reasons = [...new Set(lines.flatMap((l) => l.reasons))] as ReviewReason[];
  const flagged = lines.some((l) => l.reasons.length > 0);
  const diffTotal = Math.round(lines.reduce((a, l) => a + (l.diff_line ?? 0), 0) * 100) / 100;
  const count = (r: ReviewReason) => lines.filter((l) => l.reasons.includes(r)).length;
  const names: Record<ReviewReason, string> = { precio: "precio", iva: "IVA", sku: "SKU", producto_desconocido: "producto desconocido" };
  const summary = reasons.map((r) => `${names[r]} (${count(r)} línea${count(r) === 1 ? "" : "s"})`).join(", ");
  return { flagged, detail: { lines, reasons, window_hours: hours, diff_total: diffTotal }, summary };
}
