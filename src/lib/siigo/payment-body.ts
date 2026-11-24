// Pagos de una factura de Siigo a partir de las líneas de pago de la venta (sale_payments). Código sin base de datos.
//
// Lo CONFIRMADO (documentación oficial de Siigo, "Crear factura", y GET /v1/payment-types?document_type=FV):
//  - payments es una lista de { id, value, due_date }. id: obligatorio, debe existir y estar activo. value: obligatorio, hasta 2 decimales.
//  - due_date (yyyy-MM-dd): obligatorio SOLO si la forma de pago tiene due_date=true (p. ej. 1667 "Crédito"). Solo se admite UNA
//    forma de pago con fecha de vencimiento por factura.
// Lo que Siigo NO documenta (y por eso aquí no se supone): si exige que la suma de los pagos sea igual al total, y qué error
// devuelve si no. Por seguridad el POS lo exige él mismo ANTES de enviar: si no coincide, no se factura.
import { round2 } from "../money";
import { paymentShortLabel, type LineMethod } from "../payments";
import { siigoPaymentId } from "./payment";

export type SalePayLine = {
  method: LineMethod;
  amount: number;
  reference: string | null;
  credit_days: number | null;
  /** YYYY-MM-DD */
  due_date: string | null;
};

export type SiigoPayment = { id: number; value: number; due_date?: string };

/** La suma de los pagos no coincide con el total de la factura (o hay otro problema que impide enviar los pagos). */
export class PaymentsMismatchError extends Error {}

const cents = (n: number) => Math.round(n * 100);

/** Un pago por línea. Verifica la suma ANTES de enviar: si no coincide con el total, lanza PaymentsMismatchError. */
export function buildSiigoPayments(lines: SalePayLine[], total: number): SiigoPayment[] {
  if (!lines.length) throw new PaymentsMismatchError("La venta no tiene líneas de pago: no se puede facturar");
  const payments: SiigoPayment[] = lines.map((l) => {
    const id = siigoPaymentId(l.method);
    if (!id) throw new Error(`No hay forma de pago de Siigo para "${l.method}" (src/config/siigo-map.ts)`);
    const p: SiigoPayment = { id, value: round2(l.amount) };
    if (l.method === "credito_fecp") {
      if (!l.due_date) throw new PaymentsMismatchError("La línea de Crédito FECP no tiene fecha de vencimiento: no se puede facturar");
      p.due_date = l.due_date;
    }
    return p;
  });
  if (payments.filter((p) => p.due_date).length > 1) {
    throw new PaymentsMismatchError("Siigo solo admite una forma de pago con fecha de vencimiento por factura");
  }
  const sum = payments.reduce((a, p) => a + cents(p.value), 0);
  if (sum !== cents(round2(total))) {
    throw new PaymentsMismatchError(
      `La suma de los pagos (${(sum / 100).toFixed(2)}) no coincide con el total de la factura (${round2(total).toFixed(2)}). No se envió a Siigo; revise las líneas de pago de la venta.`
    );
  }
  return payments;
}

const noAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const amountText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/**
 * Texto de observations. Incluye el UUID (la búsqueda por observations para reconciliar depende de él) y cada medio con su
 * monto y referencia, p. ej.:  POS FECP venta {UUID} | Tarjeta 40000 ref 4821 | Credito FECP 30400 30d | Efectivo 50000
 */
export function buildObservations(p: { saleId: string; lines: SalePayLine[]; test: boolean; warehouse?: string | null }): string {
  const parts = p.lines.map((l) => {
    let s = `${noAccents(paymentShortLabel(l.method))} ${amountText(round2(l.amount))}`;
    if (l.reference) s += ` ref ${l.reference}`;
    if (l.credit_days) s += ` ${l.credit_days}d`;
    return s;
  });
  // La bodega va DESPUÉS del UUID de la venta (la reconciliación busca el UUID) y con tope de largo para no pasarse del límite de Siigo
  const wh = p.warehouse ? ` | Bodega ${noAccents(p.warehouse).replace(/s+/g, " ").trim().slice(0, 40)}` : "";
  return (p.test ? "PRUEBA POS - ELIMINAR | " : "") + `POS FECP venta ${p.saleId}${wh} | ${parts.join(" | ")}`;
}
