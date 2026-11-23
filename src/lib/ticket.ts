// Construye los datos de una tirilla a partir de una venta del navegador (cola local).
// Se usa cuando el servidor no está disponible. Es código puro (sirve en navegador y servidor).
import { cartTotals, lineAmounts, round2, type CartLine } from "./money";
import { bogotaDay, joinedReference, saleMethodOf, validatePaymentLines, type PayLineIn } from "./payment-lines";
import { CONSUMIDOR_FINAL_ID, ID_TYPE_LABELS, type PaymentLineView, type SaleIn, type SaleItemIn, type TicketData } from "./sale-types";

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
    return { name: "Consumidor final", idType: ID_TYPE_LABELS["13"], identification: CONSUMIDOR_FINAL_ID };
  }
  // display_name: el nombre completo que mostró la búsqueda (la venta solo manda tipo y número de un cliente que ya existe)
  const name = c.display_name || c.company_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || c.identification;
  return { name, idType: ID_TYPE_LABELS[c.id_type] ?? c.id_type, identification: c.identification };
}

/** Líneas de pago de una venta del navegador (formato nuevo o el viejo de la cola local), con cambio y vencimiento. */
export function ticketPayments(sale: SaleIn, total: number): PaymentLineView[] {
  const input: PayLineIn[] = sale.payments ?? [
    { method: sale.payment_method ?? "efectivo", amount: total, reference: sale.payment_reference ?? null, cash_received: sale.cash_received ?? null, credit_days: null },
  ];
  const v = validatePaymentLines(input, total, {
    saleDay: bogotaDay(sale.created_at_device),
    customerIdentified: !!sale.customer && sale.customer.identification !== CONSUMIDOR_FINAL_ID,
  });
  if (v.ok) return v.lines;
  // La tirilla provisional nunca se rompe: si algo no cuadra se muestran las líneas tal cual
  return input.map((l) => ({
    method: l.method, amount: l.amount, reference: l.reference ?? null, cash_received: l.cash_received ?? null,
    change_given: null, credit_days: l.credit_days ?? null, due_date: null,
  }));
}

export function buildTicketFromSale(sale: SaleIn, cashierName: string): TicketData {
  const lines = sale.items.map(itemToLine);
  const t = cartTotals(lines);
  const cust = customerDisplay(sale.customer);
  const total = t.total;
  const payments = ticketPayments(sale, total);
  const cashLine = payments.find((p) => p.method === "efectivo") ?? null;
  return {
    id: sale.id,
    local_number: sale.local_number,
    status: "pending",
    created_at: sale.created_at_device,
    cashier_name: cashierName,
    customer_name: cust.name,
    customer_id_type: cust.idType,
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
    payment_method: saleMethodOf(payments),
    payment_reference: joinedReference(payments),
    cash_received: cashLine?.cash_received ?? null,
    change_given: cashLine?.change_given ?? null,
    payments,
    invoice_name: null,
    cufe: null,
  };
}
