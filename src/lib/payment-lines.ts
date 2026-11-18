// Cobro DIVIDIDO: reglas de las líneas de pago de una venta. Código puro (sin base de datos): lo usan el SERVIDOR
// (POST /api/sales, que es quien manda) y el NAVEGADOR (el modal de cobro y la tirilla provisional), para que
// la validación sea idéntica en los dos lados. El servidor nunca confía en la interfaz: vuelve a validar todo.
//
// Reglas:
//  1. Una venta tiene 1 a 4 líneas de pago, una por medio.
//  2. La suma de los montos aplicados es EXACTAMENTE el total de la venta (que el servidor calcula de los productos).
//  3. Efectivo es el único medio que puede recibir más de lo aplicado (cash_received / change_given solo en esa línea).
//     Los demás medios llevan el monto exacto y no pueden superar lo que falta por cubrir.
//  4. Tarjeta y Transferencia exigen referencia por línea.
//  5. Pago electrónico (ePayco) solo puede ser el ÚNICO medio y se cobra por su propio flujo (no entra por aquí).
//  6. Crédito FECP exige cliente identificado (cédula o NIT real, no Consumidor final) y un plazo de 14/30/60/90 días;
//     due_date = fecha de la venta + plazo. El POS no lleva cupo ni abonos: eso queda en Siigo.
import { round2 } from "./money";
import { isCardMethod, isCreditMethod, paymentLabel, requiresReference, type LineMethod } from "./payments";

export const MAX_PAY_LINES = 4;
export const CREDIT_DAYS_OPTIONS = [14, 30, 60, 90] as const;
/** Medios que una línea de la CAJA puede usar (el electrónico tiene su propio flujo; los históricos solo vienen en ventas viejas) */
export const SPLIT_METHODS: LineMethod[] = ["efectivo", "tarjeta", "transferencia", "credito_fecp"];
const ALL_LINE_METHODS: string[] = [...SPLIT_METHODS, "epayco", "tarjeta_debito", "tarjeta_credito"];

/** Lo que el navegador manda por cada línea de pago */
export type PayLineIn = {
  method: LineMethod;
  /** monto APLICADO a la venta (en efectivo: lo que se cobra de la venta, no el billete entregado) */
  amount: number;
  reference?: string | null;
  /** solo efectivo: lo que entregó el cliente (≥ amount). Vacío = exacto */
  cash_received?: number | null;
  /** solo crédito: 14, 30, 60 o 90 */
  credit_days?: number | null;
};

/** Línea ya validada y completada por el servidor (o por la tirilla) */
export type PayLine = {
  method: LineMethod;
  amount: number;
  reference: string | null;
  cash_received: number | null;
  change_given: number | null;
  credit_days: number | null;
  /** YYYY-MM-DD (fecha de la venta + plazo) */
  due_date: string | null;
};

export type LinesResult = { ok: true; lines: PayLine[] } | { ok: false; error: string };

const cop = (n: number) => `$ ${Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
const cents = (n: number) => Math.round(n * 100);

/** YYYY-MM-DD + n días (en UTC puro: sin horario de verano ni desfases) */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Fecha (YYYY-MM-DD) de un instante en hora de Bogotá */
export function bogotaDay(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export type LinesContext = {
  /** fecha de la venta (Bogotá) para calcular el vencimiento del crédito */
  saleDay: string;
  /** ¿la venta tiene un cliente identificado con cédula/NIT real (no Consumidor final)? */
  customerIdentified: boolean;
};

/**
 * Valida las líneas contra el total. Devuelve las líneas completas (cambio, vencimiento) o un mensaje de error en español.
 * `total` es el total de la venta calculado por el SERVIDOR; nunca un monto que mande el navegador.
 */
export function validatePaymentLines(input: PayLineIn[], total: number, ctx: LinesContext): LinesResult {
  const T = cents(round2(total));
  if (!Array.isArray(input) || input.length < 1) return { ok: false, error: "Agrega al menos un medio de pago" };
  if (input.length > MAX_PAY_LINES) return { ok: false, error: `Máximo ${MAX_PAY_LINES} medios de pago por venta` };

  const methods = input.map((l) => l.method);
  if (methods.some((m) => !ALL_LINE_METHODS.includes(m))) return { ok: false, error: "Medio de pago inválido" };
  if (new Set(methods).size !== methods.length) return { ok: false, error: "No se puede repetir un medio de pago: una línea por medio" };
  if (methods.includes("epayco") && input.length > 1) {
    return { ok: false, error: "El pago electrónico (ePayco) solo puede ser el único medio de la venta" };
  }

  const out: PayLine[] = [];
  let sum = 0;
  for (const l of input) {
    if (typeof l.amount !== "number" || !Number.isFinite(l.amount)) return { ok: false, error: "Monto de pago inválido" };
    if (Math.abs(l.amount * 100 - Math.round(l.amount * 100)) > 1e-6) return { ok: false, error: "Los montos admiten máximo 2 decimales" };
    const amt = cents(l.amount);
    if (!(amt > 0)) return { ok: false, error: "Cada medio de pago debe tener un monto mayor a cero" };
    sum += amt;

    const reference = typeof l.reference === "string" ? l.reference.trim().slice(0, 60) : "";
    if (requiresReference(l.method) && l.method !== "epayco" && !reference) {
      return { ok: false, error: `Falta la referencia o los últimos dígitos del comprobante (${l.method === "transferencia" ? "Transferencia" : "Tarjeta"})` };
    }

    // Solo el efectivo recibe más de lo aplicado
    let received: number | null = null;
    let change: number | null = null;
    if (l.method === "efectivo") {
      received = l.cash_received == null ? l.amount : l.cash_received;
      if (typeof received !== "number" || !Number.isFinite(received) || received < 0) return { ok: false, error: "Valor recibido inválido" };
      if (cents(received) < amt) return { ok: false, error: "El efectivo recibido es menor al monto aplicado en efectivo" };
      change = round2(received - l.amount);
    } else if (l.cash_received != null) {
      return { ok: false, error: "Solo el efectivo puede recibir más de lo aplicado" };
    }

    let days: number | null = null;
    let due: string | null = null;
    if (isCreditMethod(l.method)) {
      days = typeof l.credit_days === "number" ? l.credit_days : NaN;
      if (!CREDIT_DAYS_OPTIONS.includes(days as (typeof CREDIT_DAYS_OPTIONS)[number])) {
        return { ok: false, error: `El crédito exige un plazo de ${CREDIT_DAYS_OPTIONS.join(", ")} días` };
      }
      if (!ctx.customerIdentified) {
        return { ok: false, error: "El Crédito FECP exige un cliente identificado con cédula o NIT (no Consumidor final)" };
      }
      due = addDays(ctx.saleDay, days);
    } else if (l.credit_days != null) {
      return { ok: false, error: "Solo el Crédito FECP lleva plazo" };
    }

    out.push({
      method: l.method,
      amount: round2(l.amount),
      reference: l.method === "efectivo" || isCreditMethod(l.method) ? (reference || null) : reference,
      cash_received: received === null ? null : round2(received),
      change_given: change,
      credit_days: days,
      due_date: due,
    });
  }

  if (sum < T) return { ok: false, error: `Falta por cubrir ${cop((T - sum) / 100)}: la suma de los pagos debe ser igual al total` };
  if (sum > T) {
    // Solo el efectivo puede "pasarse" (con cambio, pero sobre lo RECIBIDO, no sobre lo aplicado). Un medio que no es efectivo
    // no puede superar lo que falta por cubrir con los demás.
    for (const l of out) {
      if (l.method === "efectivo") continue;
      const allowed = T - (sum - cents(l.amount));
      if (cents(l.amount) > allowed) {
        return { ok: false, error: `El monto de ${paymentLabel(l.method)} (${cop(l.amount)}) supera lo que falta por cubrir (${cop(Math.max(allowed, 0) / 100)})` };
      }
    }
    return { ok: false, error: `Los pagos suman ${cop((sum - T) / 100)} de más: deben sumar exactamente el total` };
  }
  return { ok: true, lines: out };
}

/** Falta por cubrir (en pesos, nunca negativo en pantalla): total − suma de los montos aplicados */
export function missingToCover(total: number, applied: number[]): number {
  return (cents(round2(total)) - applied.reduce((a, n) => a + cents(n), 0)) / 100;
}

/** sales.payment_method según las líneas: el medio de la única línea, o "mixto" */
export const saleMethodOf = (lines: { method: LineMethod }[]): LineMethod | "mixto" => (lines.length > 1 ? "mixto" : lines[0].method);

/** sales.payment_reference (columna vieja, por compatibilidad): las referencias de las líneas, separadas por " / " */
export const joinedReference = (lines: { reference: string | null }[]): string | null => {
  const refs = lines.map((l) => l.reference).filter((r): r is string => !!r);
  return refs.length ? refs.join(" / ").slice(0, 200) : null;
};

/** Medios (únicos) de una lista de líneas, para las reglas del comprobante */
export const methodsOf = (lines: { method: string }[]) => [...new Set(lines.map((l) => l.method))];

/** ¿Alguna línea es tarjeta (actual o histórica)? */
export const hasCard = (methods: string[]) => methods.some(isCardMethod);
