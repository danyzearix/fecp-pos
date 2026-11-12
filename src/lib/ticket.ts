// Construye los datos de una tirilla a partir de una venta del navegador (cola local).
// Se usa cuando el servidor no está disponible. Es código puro (sirve en navegador y servidor).
import { cartTotals, lineAmounts, round2, type CartLine } from "./money";
import { CONSUMIDOR_FINAL_ID, type SaleIn, type SaleItemIn, type TicketData } from "./sale-types";

export const itemToLine = (i: SaleItemIn): CartLine => ({
  productId: i.product_id,
  sku: i.sku,
  barcode: null,
  name: i.name,
  unitPrice: i.unit_price,
  taxRate: i.tax_rate,
  includesTax: i.prices_include_tax,
  qty: i.quantity,
});

export function customerDisplay(c: SaleIn["customer"]) {
  if (!c || c.identification === CONSUMIDOR_FINAL_ID) {
    return { name: "Consumidor final", identification: CONSUMIDOR_FINAL_ID };
  }
  const name = c.company_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.identification;
  return { name, identification: c.identification };
}

export function buildTicketFromSale(sale: SaleIn, cashierName: string): TicketData {
  const lines = sale.items.map(itemToLine);
  const t = cartTotals(lines);
  const cust = customerDisplay(sale.customer);
  const total = t.total;
  return {
    id: sale.id,
    local_number: sale.local_number,
    status: "pending",
    created_at: sale.created_at_device,
    cashier_name: cashierName,
    customer_name: cust.name,
    customer_identification: cust.identification,
    items: lines.map((l) => ({
      name: l.name,
      quantity: l.qty,
      unit_price: l.unitPrice,
      line_total: lineAmounts(l).total,
      tax_rate: l.taxRate,
    })),
    subtotal: t.subtotal,
    tax_total: t.tax,
    total,
    tax_by_rate: Object.entries(t.byRate)
      .map(([rate, v]) => ({ rate: Number(rate), base: round2(v.base), tax: round2(v.tax) }))
      .sort((a, b) => a.rate - b.rate),
    payment_method: sale.payment_method,
    payment_reference: sale.payment_reference ?? null,
    cash_received: sale.cash_received,
    change_given: sale.cash_received == null ? null : round2(sale.cash_received - total),
    invoice_name: null,
    cufe: null,
  };
}
