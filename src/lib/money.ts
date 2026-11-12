// Formato de moneda y cálculo de impuestos (se usa en navegador y servidor).

/** $ 30.500 (sin decimales en pantalla) */
export function formatCOP(n: number): string {
  const r = Math.round(n);
  const s = Math.abs(r).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${r < 0 ? "-" : ""}$ ${s}`;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type CartLine = {
  productId: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  unitPrice: number; // precio tal como está en la tienda
  taxRate: number; // 0, 5 o 19
  includesTax: boolean; // ¿unitPrice ya trae IVA?
  qty: number;
};

/** base (sin IVA), iva y total (lo que paga el cliente) de una línea */
export function lineAmounts(l: CartLine) {
  const gross = round2(l.unitPrice * l.qty);
  if (l.includesTax) {
    const base = round2(gross / (1 + l.taxRate / 100));
    return { base, tax: round2(gross - base), total: gross };
  }
  const tax = round2((gross * l.taxRate) / 100);
  return { base: gross, tax, total: round2(gross + tax) };
}

export function cartTotals(lines: CartLine[]) {
  let subtotal = 0;
  let tax = 0;
  let total = 0;
  const byRate: Record<number, { base: number; tax: number }> = {};
  for (const l of lines) {
    const a = lineAmounts(l);
    subtotal += a.base;
    tax += a.tax;
    total += a.total;
    const g = (byRate[l.taxRate] ??= { base: 0, tax: 0 });
    g.base += a.base;
    g.tax += a.tax;
  }
  return { subtotal: round2(subtotal), tax: round2(tax), total: round2(total), byRate };
}
