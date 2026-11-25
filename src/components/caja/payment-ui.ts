// Estado y cálculos (puros) de las líneas de pago del modal de cobro. La VALIDACIÓN real vive en src/lib/payment-lines.ts
// (la misma que usa el servidor); aquí solo se arma lo que la pantalla necesita.
import { round2 } from "@/lib/money";
import { CREDIT_DAYS_DEFAULT, type PayLineIn } from "@/lib/payment-lines";
import type { LineMethod } from "@/lib/payments";

/**
 * Una línea en pantalla. `amount === null` = línea AUTOMÁTICA: toma lo que falta por cubrir con las demás (así el efectivo se
 * completa solo). Al escribir un monto la línea queda FIJA. Solo la primera línea automática absorbe el resto.
 */
export type LineUi = {
  key: number;
  method: LineMethod;
  amount: number | null;
  reference: string;
  /** casilla "Verifiqué el pago en el datáfono o en la cuenta de FECP" (solo tarjeta y transferencia) */
  verified: boolean;
  /** efectivo: lo que entregó el cliente (texto de dígitos). Vacío = exacto */
  cashStr: string;
  /** crédito: (ya no se elige) el plazo único se pone al armar la venta */
  days: number | null;
};

let nextKey = 1;
export const newLine = (method: LineMethod): LineUi => ({ key: nextKey++, method, amount: null, reference: "", verified: false, cashStr: "", days: null });

/** Monto aplicado de cada línea: las fijas tal cual; la primera automática recibe lo que falta (nunca negativo) */
export function resolveAmounts(lines: LineUi[], total: number): number[] {
  const fixed = lines.reduce((a, l) => a + (l.amount ?? 0), 0);
  const autoIdx = lines.findIndex((l) => l.amount === null);
  const rest = Math.max(0, round2(total - fixed));
  return lines.map((l, i) => (l.amount !== null ? l.amount : i === autoIdx ? rest : 0));
}

/** Falta por cubrir (positivo) o sobra (negativo): total − suma de montos aplicados */
export const missingOf = (lines: LineUi[], total: number) => round2(total - resolveAmounts(lines, total).reduce((a, n) => a + n, 0));

export const parseDigits = (s: string) => Number(s.replace(/\D/g, "")) || 0;

/** Lo que se manda al servidor (que lo vuelve a validar todo) */
export function toPayLinesIn(lines: LineUi[], total: number, creditDays: number = CREDIT_DAYS_DEFAULT): PayLineIn[] {
  const amounts = resolveAmounts(lines, total);
  return lines.map((l, i) => ({
    method: l.method,
    amount: amounts[i],
    reference: l.reference.trim() || null,
    cash_received: l.method === "efectivo" && l.cashStr ? parseDigits(l.cashStr) : null,
    credit_days: l.method === "credito_fecp" ? creditDays : null, // un solo plazo autorizado: no se elige
  }));
}

/** $ 1.234 o $ 1.234,50 (los centavos solo si los hay) */
export function formatMoney(n: number): string {
  const r = round2(n);
  if (Number.isInteger(r)) return `$ ${Math.round(r).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
  return `$ ${r.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
