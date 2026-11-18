// Servidor: validar y registrar ventas, y leer datos de tirilla.
import type { PoolClient } from "pg";
import { pool, query } from "./db";
import { writeLog } from "./log";
import { cartTotals, lineAmounts, round2 } from "./money";
import { getPosConfig } from "./config";
import { itemToLine } from "./ticket";
import { receiptRequired, type ReceiptStatus } from "./receipt-rules";
import { checkPrices } from "./price-check";
import { bogotaDay, joinedReference, MAX_PAY_LINES, methodsOf, saleMethodOf, validatePaymentLines, type PayLine, type PayLineIn } from "./payment-lines";
import {
  CONSUMIDOR_FINAL_ID,
  ID_TYPES,
  type CustomerIn,
  type LineMethod,
  type SaleIn,
  type TicketData,
} from "./sale-types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isUuid = (s: string) => UUID_RE.test(s);

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);

export function parseCustomer(raw: unknown): CustomerIn | null | string {
  if (raw == null) return null;
  if (typeof raw !== "object") return "Cliente inválido";
  const c = raw as Record<string, unknown>;
  const identification = str(c.identification, 20);
  if (!identification) return null;
  const id_type = str(c.id_type, 2) || "13";
  if (!ID_TYPES.some((t) => t.id === id_type)) return "Tipo de documento inválido";
  if (!/^[0-9A-Za-z-]{3,20}$/.test(identification)) return "Número de documento inválido";
  const email = str(c.email);
  if (email && !EMAIL_RE.test(email)) return "Correo inválido";
  return {
    id_type,
    identification,
    check_digit: str(c.check_digit, 2),
    first_name: str(c.first_name),
    last_name: str(c.last_name),
    company_name: str(c.company_name),
    email,
    phone: str(c.phone, 30),
    address: str(c.address),
    state_code: str(c.state_code, 5),
    city_code: str(c.city_code, 5),
  };
}

/** Venta ya validada por el servidor: con las líneas de pago completas (cambio, vencimiento) y su total. */
export type ParsedSale = Omit<SaleIn, "payments" | "payment_method" | "payment_reference" | "cash_received"> & {
  lines: PayLine[];
  total: number;
  /** si la hora del equipo estaba fuera de rango (hace > 7 días o > 5 min en el futuro) se usó la del servidor y queda aquí la nota */
  time_note: string | null;
};

/** Límites de la hora que manda el equipo: no más de 7 días atrás ni más de 5 minutos en el futuro. */
export const DEVICE_MAX_AGE_MS = 7 * 24 * 3600_000;
export const DEVICE_MAX_AHEAD_MS = 5 * 60_000;

/** Crédito FECP: cliente con cédula/NIT REAL y datos completos (igual que el checkout completo), aunque la venta sea < 5 UVT. */
function creditCustomerError(c: CustomerIn | null): string | null {
  if (!c || c.identification === CONSUMIDOR_FINAL_ID || !["13", "22", "31"].includes(c.id_type)) {
    return "El Crédito FECP exige un cliente identificado con cédula o NIT real (no Consumidor final)";
  }
  const okName = c.id_type === "31" ? !!c.company_name : !!(c.first_name && c.last_name);
  if (!okName || !c.email || !EMAIL_RE.test(c.email) || !c.address || !c.state_code || !c.city_code) {
    return "El Crédito FECP exige los datos completos del cliente (nombre, correo, dirección, departamento y ciudad)";
  }
  if (c.id_type === "31" && !c.check_digit) return "Falta el dígito de verificación del NIT";
  return null;
}

/** Líneas de pago que manda el navegador: formato NUEVO (payments) o VIEJO (un solo medio, de la cola local anterior). */
function readPayLines(b: Record<string, unknown>, total: number): PayLineIn[] | string {
  if (Array.isArray(b.payments)) {
    const lines: PayLineIn[] = [];
    for (const raw of b.payments) {
      const l = (raw ?? {}) as Record<string, unknown>;
      // En el formato NUEVO solo existen los medios actuales (Tarjeta reemplazó a débito y crédito; los históricos solo vienen en la cola vieja)
      if (!["efectivo", "tarjeta", "transferencia", "credito_fecp", "epayco"].includes(str(l.method, 30))) return "Medio de pago inválido";
      lines.push({
        method: str(l.method, 30) as LineMethod,
        amount: num(l.amount),
        reference: str(l.reference, 60),
        cash_received: l.cash_received == null ? null : num(l.cash_received),
        credit_days: l.credit_days == null ? null : num(l.credit_days),
      });
    }
    return lines;
  }
  // Formato viejo: UN medio por el total. Los históricos (tarjeta débito/crédito) siguen válidos aquí; el crédito y ePayco, no.
  const method = ["efectivo", "tarjeta", "transferencia", "tarjeta_debito", "tarjeta_credito"].find((m) => m === b.payment_method) as LineMethod | undefined;
  if (!method) return b.payment_method === "epayco" ? "El pago electrónico se cobra por su propio flujo (no se registra aquí)" : "Medio de pago inválido";
  const cash = b.cash_received == null ? null : num(b.cash_received);
  if (method === "efectivo" && (cash === null || !(cash + 0.005 >= total))) return "El valor recibido es menor al total";
  return [{ method, amount: total, reference: str(b.payment_reference, 60), cash_received: method === "efectivo" ? cash : null, credit_days: null }];
}

/** Devuelve la venta limpia o un mensaje de error en español. */
export function parseSale(body: unknown): ParsedSale | string {
  if (!body || typeof body !== "object") return "Cuerpo inválido";
  const b = body as Record<string, unknown>;

  const id = str(b.id, 40);
  if (!isUuid(id)) return "id de venta inválido (debe ser UUID)";
  const local_number = str(b.local_number, 40);
  if (!local_number) return "Falta el número local";
  const checkout_type = b.checkout_type;
  if (checkout_type !== "corto" && checkout_type !== "completo") return "Tipo de checkout inválido";
  const customer = parseCustomer(b.customer);
  if (typeof customer === "string") return customer;

  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 500) return "La venta no tiene productos";
  const items: SaleIn["items"] = [];
  for (const raw of b.items) {
    const i = (raw ?? {}) as Record<string, unknown>;
    const quantity = num(i.quantity);
    const unit_price = num(i.unit_price);
    const tax_rate = num(i.tax_rate);
    const sku = str(i.sku, 100);
    if (!(quantity > 0) || !(unit_price >= 0) || ![0, 5, 19].includes(tax_rate) || !sku) {
      return `Producto inválido: ${str(i.name) || "(sin nombre)"}`;
    }
    items.push({
      product_id: num(i.product_id),
      sku,
      name: str(i.name, 300) || sku,
      quantity,
      unit_price,
      tax_rate,
      prices_include_tax: i.prices_include_tax !== false,
    });
  }

  // Hora del equipo: se acepta entre "hace 7 días" y "ahora + 5 minutos". Fuera de ese rango (o ilegible) se usa la hora del
  // servidor y se anota (no se rechaza la venta).
  const rawCreated = str(b.created_at_device, 40);
  const created = new Date(rawCreated);
  const nowMs = Date.now();
  const inRange = !isNaN(created.getTime()) && created.getTime() >= nowMs - DEVICE_MAX_AGE_MS && created.getTime() <= nowMs + DEVICE_MAX_AHEAD_MS;
  const createdIso = inRange ? created.toISOString() : new Date(nowMs).toISOString();
  const timeNote = inRange ? null : `Hora del equipo fuera de rango (${rawCreated || "sin hora"}): se usó la hora del servidor`;

  // ---- Pagos: el TOTAL lo calcula el servidor desde los productos; los montos del navegador solo se comparan con él ----
  const total = cartTotals(items.map(itemToLine)).total;
  const linesIn = readPayLines(b, total);
  if (typeof linesIn === "string") return linesIn;
  if (linesIn.length > MAX_PAY_LINES) return `Máximo ${MAX_PAY_LINES} medios de pago por venta`;
  if (linesIn.some((l) => l.method === "epayco")) {
    return linesIn.length > 1
      ? "El pago electrónico (ePayco) solo puede ser el único medio de la venta"
      : "El pago electrónico se cobra por su propio flujo (no se registra aquí)";
  }
  const hasCredit = linesIn.some((l) => l.method === "credito_fecp");
  if (hasCredit) {
    if (checkout_type !== "completo") return "El Crédito FECP exige el checkout completo (datos completos del cliente)";
    const ce = creditCustomerError(customer);
    if (ce) return ce;
  }
  const v = validatePaymentLines(linesIn, total, {
    saleDay: bogotaDay(createdIso),
    customerIdentified: !!customer && customer.identification !== CONSUMIDOR_FINAL_ID,
  });
  if (!v.ok) return v.error;

  return { id, local_number, created_at_device: createdIso, checkout_type, customer, items, lines: v.lines, total, time_note: timeNote };
}

/** "Maria Fernanda Lopez" → ["Maria Fernanda", "Lopez"] */
export function splitName(full: string): [string, string] {
  const t = full.trim().split(/\s+/).filter(Boolean);
  if (t.length <= 1) return [t[0] ?? "", ""];
  const k = Math.ceil(t.length / 2);
  return [t.slice(0, k).join(" "), t.slice(k).join(" ")];
}

export type CreateSaleResult =
  | { ok: true; id: string; status: string; invoice_name: string | null; duplicate: boolean }
  | { ok: false; error: string };

/**
 * Cliente de una venta hecha por un EMPLEADO (caja): sin cédula = consumidor final; los datos nuevos completan o
 * actualizan al cliente existente. La dirección/ciudad faltantes se completan con las del punto de venta.
 * (El kiosco NO usa esto: allí un cliente existente nunca se modifica.)
 */
export async function upsertCashierCustomer(client: PoolClient, customer: CustomerIn | null): Promise<number> {
  const cfg = getPosConfig();
  const c: CustomerIn = customer ?? { id_type: "13", identification: CONSUMIDOR_FINAL_ID, first_name: "Consumidor", last_name: "final" };
  const address = c.address || process.env.POS_ADDRESS || "";
  const state = c.state_code || cfg.defaultStateCode;
  const city = c.city_code || cfg.defaultCityCode;
  const r = await client.query<{ id: number }>(
    `INSERT INTO customers (id_type, identification, check_digit, first_name, last_name, company_name, email, phone, address, state_code, city_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (identification) DO UPDATE SET
       id_type      = CASE WHEN customers.identification = $12 THEN customers.id_type ELSE EXCLUDED.id_type END,
       check_digit  = COALESCE(NULLIF(EXCLUDED.check_digit,''),  customers.check_digit),
       first_name   = CASE WHEN customers.identification = $12 THEN customers.first_name ELSE COALESCE(NULLIF(EXCLUDED.first_name,''), customers.first_name) END,
       last_name    = CASE WHEN customers.identification = $12 THEN customers.last_name  ELSE COALESCE(NULLIF(EXCLUDED.last_name,''),  customers.last_name)  END,
       company_name = COALESCE(NULLIF(EXCLUDED.company_name,''), customers.company_name),
       email        = COALESCE(NULLIF(EXCLUDED.email,''),        customers.email),
       phone        = COALESCE(NULLIF(EXCLUDED.phone,''),        customers.phone),
       address      = COALESCE(NULLIF(EXCLUDED.address,''),      customers.address),
       state_code   = COALESCE(NULLIF(EXCLUDED.state_code,''),   customers.state_code),
       city_code    = COALESCE(NULLIF(EXCLUDED.city_code,''),    customers.city_code)
     RETURNING id`,
    [
      c.id_type, c.identification, c.check_digit ?? "", c.first_name ?? "", c.last_name ?? "", c.company_name ?? "",
      c.email ?? "", c.phone ?? "", address, state, city, CONSUMIDOR_FINAL_ID,
    ]
  );
  return r.rows[0].id;
}

/**
 * Registra la venta. Idempotente: si el mismo UUID llega dos veces, la segunda vez no inserta nada
 * (INSERT ... ON CONFLICT (id) DO NOTHING) y devuelve el estado actual.
 */
export async function createSale(sale: ParsedSale, cashierId: number): Promise<CreateSaleResult> {
  const lines = sale.items.map(itemToLine);
  const totals = cartTotals(lines);

  // Defensa en profundidad: las líneas ya se validaron en parseSale; aquí se re-comprueba contra el total recalculado
  const recheck = validatePaymentLines(
    sale.lines.map((l) => ({ method: l.method, amount: l.amount, reference: l.reference, cash_received: l.cash_received, credit_days: l.credit_days })),
    totals.total,
    { saleDay: bogotaDay(sale.created_at_device), customerIdentified: !!sale.customer && sale.customer.identification !== CONSUMIDOR_FINAL_ID }
  );
  if (!recheck.ok) return { ok: false, error: recheck.error };
  const payLines = recheck.lines;
  const cashLine = payLines.find((l) => l.method === "efectivo") ?? null;

  // Precios: cada línea se compara con la base (y su historial reciente). Tolerancia cero. Si algo no coincide la venta se
  // ACEPTA igual (el cliente ya pagó) pero queda retenida: no se factura sola hasta que un admin la decida.
  const pc = await checkPrices(sale.items);
  const heldReason = pc.flagged ? `Precio por revisar: ${pc.summary}. Se decide en Admin → Precios por revisar.` : null;

  const cfg = getPosConfig();
  if (sale.checkout_type === "corto" && totals.subtotal > 5 * cfg.uvt) {
    await writeLog("venta", `Venta ${sale.local_number} con checkout corto pero base > 5 UVT`, {
      level: "warn",
      userId: cashierId,
      detail: { id: sale.id, base: totals.subtotal, limite: 5 * cfg.uvt },
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const cust = { rows: [{ id: await upsertCashierCustomer(client, sale.customer) }] };

    const ins = await client.query(
      `INSERT INTO sales (id, local_number, cashier_id, customer_id, checkout_type, subtotal, tax_total, total,
                          payment_method, cash_received, change_given, status, created_at_device, payment_reference,
                          price_review_status, price_review_detail, price_review_at, last_error, time_note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13,
               $14, $15::jsonb, CASE WHEN $14::text IS NULL THEN NULL ELSE now() END, $16, $17)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        sale.id, sale.local_number, cashierId, cust.rows[0].id, sale.checkout_type,
        totals.subtotal, totals.tax, totals.total,
        // columnas viejas (compatibilidad): el medio de la única línea o "mixto"; el efectivo y sus referencias
        saleMethodOf(payLines), cashLine?.cash_received ?? null, cashLine?.change_given ?? null, sale.created_at_device, joinedReference(payLines),
        pc.flagged ? "pendiente" : null, pc.flagged ? JSON.stringify(pc.detail) : null, heldReason, sale.time_note,
      ]
    );

    const inserted = (ins.rowCount ?? 0) > 0;
    // Líneas de pago (una por medio). Reportes, cuadre e historial calculan desde sale_payments.
    if (inserted) {
      for (let i = 0; i < payLines.length; i++) {
        const l = payLines[i];
        await client.query(
          `INSERT INTO sale_payments (sale_id, method, amount, reference, cash_received, change_given, credit_days, due_date, ord)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [sale.id, l.method, l.amount, l.reference, l.cash_received, l.change_given, l.credit_days, l.due_date, i + 1]
        );
      }
    }
    // Si hay una línea de Transferencia, el comprobante es obligatorio. La foto se sube DESPUÉS de que la venta exista (puede
    // venir de la cola sin conexión); mientras no llegue, la venta queda con "Comprobante pendiente".
    if (inserted && receiptRequired(methodsOf(payLines))) {
      await client.query("INSERT INTO sale_receipts (sale_id, status) VALUES ($1, 'pendiente') ON CONFLICT (sale_id) DO NOTHING", [sale.id]);
    }
    if (inserted) {
      for (const it of sale.items) {
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, sku, name, quantity, unit_price, tax_rate, line_total, prices_include_tax)
           VALUES ($1,(SELECT id FROM products WHERE id = $2),$3,$4,$5,$6,$7,$8,$9)`,
          [
            sale.id, Number.isFinite(it.product_id) ? it.product_id : null, it.sku, it.name, it.quantity,
            it.unit_price, it.tax_rate, lineAmounts(itemToLine(it)).total, it.prices_include_tax,
          ]
        );
      }
    }
    await client.query("COMMIT");

    if (inserted && pc.flagged) {
      // Sin datos personales: solo el motivo, la cantidad de líneas y la diferencia
      await writeLog("venta", `Venta ${sale.local_number} RETENIDA por precio por revisar: ${pc.summary}`, {
        level: "warn",
        userId: cashierId,
        detail: { id: sale.id, reasons: pc.detail.reasons, lines_flagged: pc.detail.lines.filter((l) => l.reasons.length).length, diff_total: pc.detail.diff_total, window_hours: pc.detail.window_hours },
      });
    }
    if (inserted && sale.time_note) {
      await writeLog("venta", `Venta ${sale.local_number}: ${sale.time_note}`, { level: "warn", userId: cashierId, detail: { id: sale.id } });
    }
    if (inserted) {
      await writeLog("venta", `Venta ${sale.local_number} registrada por $${totals.total}`, {
        userId: cashierId,
        detail: { id: sale.id, total: totals.total, payment: saleMethodOf(payLines), lines: payLines.map((l) => ({ m: l.method, a: l.amount })), items: sale.items.length, checkout: sale.checkout_type },
      });
    }

    const cur = await query<{ status: string; invoice_name: string | null }>(
      "SELECT status, invoice_name FROM sales WHERE id = $1",
      [sale.id]
    );
    return { ok: true, id: sale.id, status: cur.rows[0].status, invoice_name: cur.rows[0].invoice_name, duplicate: !inserted };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Subconsulta: las líneas de pago de la venta (alias s) como JSON, en orden. due_date como texto YYYY-MM-DD. */
export const PAY_LINES_SQL = `(SELECT json_agg(json_build_object(
    'method', sp.method, 'amount', sp.amount::float8,
    'reference', COALESCE(sp.reference, CASE WHEN sp.method = 'epayco' THEN s.payment_reference END),
    'cash_received', sp.cash_received::float8, 'change_given', sp.change_given::float8,
    'credit_days', sp.credit_days, 'due_date', to_char(sp.due_date, 'YYYY-MM-DD')) ORDER BY sp.ord)
  FROM sale_payments sp WHERE sp.sale_id = s.id)`;

type SaleRow = {
  id: string; local_number: string; status: string; created_at: Date; created_at_device: Date | null;
  subtotal: number; tax_total: number; total: number; payment_method: string; payment_reference: string | null;
  cash_received: number | null; change_given: number | null; invoice_name: string | null; cufe: string | null;
  cashier_name: string; c_first: string | null; c_last: string | null; c_company: string | null; c_ident: string | null;
  pay_lines: PayLine[] | null;
};

export async function getTicketData(id: string): Promise<TicketData | null> {
  const { rows } = await query<SaleRow>(
    `SELECT s.id, s.local_number, s.status, s.created_at, s.created_at_device,
            s.subtotal::float8 AS subtotal, s.tax_total::float8 AS tax_total, s.total::float8 AS total,
            s.payment_method, s.payment_reference, s.cash_received::float8 AS cash_received, s.change_given::float8 AS change_given,
            s.invoice_name, s.cufe, u.name AS cashier_name,
            c.first_name AS c_first, c.last_name AS c_last, c.company_name AS c_company, c.identification AS c_ident,
            ${PAY_LINES_SQL} AS pay_lines
       FROM sales s
       JOIN users u ON u.id = s.cashier_id
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.id = $1`,
    [id]
  );
  const s = rows[0];
  if (!s) return null;

  const items = await query<{
    name: string; quantity: number; unit_price: number; line_total: number; tax_rate: number; prices_include_tax: boolean;
  }>(
    `SELECT name, quantity::float8 AS quantity, unit_price::float8 AS unit_price, line_total::float8 AS line_total,
            tax_rate, prices_include_tax
       FROM sale_items WHERE sale_id = $1 ORDER BY id`,
    [id]
  );

  const byRate = new Map<number, { rate: number; base: number; tax: number }>();
  for (const i of items.rows) {
    const a = lineAmounts({
      productId: 0, sku: null, barcode: null, name: i.name, unitPrice: i.unit_price,
      taxRate: i.tax_rate, includesTax: i.prices_include_tax, qty: i.quantity,
    });
    const g = byRate.get(i.tax_rate) ?? { rate: i.tax_rate, base: 0, tax: 0 };
    g.base = round2(g.base + a.base);
    g.tax = round2(g.tax + a.tax);
    byRate.set(i.tax_rate, g);
  }

  const isCF = !s.c_ident || s.c_ident === CONSUMIDOR_FINAL_ID;
  return {
    id: s.id,
    local_number: s.local_number,
    status: s.status,
    created_at: (s.created_at_device ?? s.created_at).toISOString(),
    cashier_name: s.cashier_name,
    customer_name: isCF ? "Consumidor final" : s.c_company || [s.c_first, s.c_last].filter(Boolean).join(" ") || s.c_ident!,
    customer_identification: isCF ? CONSUMIDOR_FINAL_ID : s.c_ident!,
    items: items.rows.map((i) => ({
      name: i.name, quantity: i.quantity, unit_price: i.unit_price, line_total: i.line_total, tax_rate: i.tax_rate,
    })),
    subtotal: s.subtotal,
    tax_total: s.tax_total,
    total: s.total,
    tax_by_rate: [...byRate.values()].sort((a, b) => a.rate - b.rate),
    payment_method: s.payment_method,
    payment_reference: s.payment_reference,
    cash_received: s.cash_received,
    change_given: s.change_given,
    // Líneas de pago; si por algo no hubiera filas (no debería), se arma una sola con las columnas viejas
    payments:
      s.pay_lines && s.pay_lines.length
        ? s.pay_lines
        : [{ method: s.payment_method as LineMethod, amount: s.total, reference: s.payment_reference, cash_received: s.cash_received, change_given: s.change_given, credit_days: null, due_date: null }],
    invoice_name: s.invoice_name,
    cufe: s.cufe,
  };
}

// ---------------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------------
export const todayBogota = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const yesterdayBogota = () => {
  const [y, m, d] = todayBogota().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};
export const isDateStr = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Fecha de una venta en hora de Bogotá: la del dispositivo si existe (ventas hechas sin conexión), si no la del servidor */
export const SALE_DAY_SQL = "(COALESCE(s.created_at_device, s.created_at) AT TIME ZONE 'America/Bogota')::date";

export type SaleListRow = {
  id: string;
  local_number: string;
  invoice_name: string | null;
  customer_name: string;
  customer_identification: string;
  total: number;
  payment_method: string;
  payment_reference: string | null;
  cashier_name: string;
  status: string;
  created_at: string;
  last_error: string | null;
  /** comprobante de pago: null = sin comprobante */
  receipt_status: ReceiptStatus | null;
  receipt_uploaded_at: string | null;
  receipt_uploaded_by: string | null;
  receipt_deleted_at: string | null;
  /** fecha de la venta (Bogotá), para el nombre del archivo descargado */
  sale_day: string;
  /** líneas de pago (una por medio). payment_method vale "mixto" si hay más de una. */
  payments: PayLine[];
  /** 'pendiente' = retenida por precio por revisar (no se factura hasta que un admin decida) */
  price_review_status: "pendiente" | "aprobada" | "anulada" | null;
};

/** Filtro de comprobante en el historial */
export type ReceiptFilter = "todos" | "con" | "sin" | "pendiente";
export const isReceiptFilter = (v: unknown): v is ReceiptFilter => v === "todos" || v === "con" || v === "sin" || v === "pendiente";

export async function listSales(date: string, cashierId: number | null, receipt: ReceiptFilter = "todos"): Promise<SaleListRow[]> {
  // "Con comprobante" = tiene foto (o la tuvo y se eliminó por retención); "Pendiente" = transferencia aún sin foto;
  // "Sin comprobante" = nunca tuvo (ni pendiente).
  const rf =
    receipt === "con" ? "AND r.status IN ('activo','eliminado')" :
    receipt === "pendiente" ? "AND r.status = 'pendiente'" :
    receipt === "sin" ? "AND r.sale_id IS NULL" : "";
  const { rows } = await query<
    Omit<SaleListRow, "receipt_uploaded_at" | "receipt_deleted_at" | "payments" | "price_review_status"> & {
      price_review_status: SaleListRow["price_review_status"];
      c_first: string | null; c_last: string | null; c_company: string | null; receipt_uploaded_at: Date | null; receipt_deleted_at: Date | null;
      pay_lines: PayLine[] | null;
    }
  >(
    `SELECT s.id, s.local_number, s.invoice_name, s.total::float8 AS total, s.payment_method, s.payment_reference,
            s.status, s.last_error, COALESCE(s.created_at_device, s.created_at) AS created_at, u.name AS cashier_name,
            c.identification AS customer_identification, c.first_name AS c_first, c.last_name AS c_last, c.company_name AS c_company,
            r.status AS receipt_status, r.uploaded_at AS receipt_uploaded_at, ru.name AS receipt_uploaded_by, r.deleted_at AS receipt_deleted_at,
            ${SALE_DAY_SQL}::text AS sale_day, ${PAY_LINES_SQL} AS pay_lines, s.price_review_status
       FROM sales s
       JOIN users u ON u.id = s.cashier_id
       LEFT JOIN customers c ON c.id = s.customer_id
       LEFT JOIN sale_receipts r ON r.sale_id = s.id
       LEFT JOIN users ru ON ru.id = r.uploaded_by
      WHERE ${SALE_DAY_SQL} = $1::date AND ($2::int IS NULL OR s.cashier_id = $2) ${rf}
      ORDER BY COALESCE(s.created_at_device, s.created_at) DESC
      LIMIT 500`,
    [date, cashierId]
  );
  return rows.map((r) => {
    const isCF = !r.customer_identification || r.customer_identification === CONSUMIDOR_FINAL_ID;
    return {
      id: r.id, local_number: r.local_number, invoice_name: r.invoice_name, total: r.total,
      payment_method: r.payment_method, payment_reference: r.payment_reference, cashier_name: r.cashier_name,
      status: r.status, last_error: r.last_error, created_at: new Date(r.created_at).toISOString(),
      receipt_status: r.receipt_status ?? null, receipt_uploaded_by: r.receipt_uploaded_by ?? null,
      receipt_uploaded_at: r.receipt_uploaded_at ? new Date(r.receipt_uploaded_at).toISOString() : null,
      receipt_deleted_at: r.receipt_deleted_at ? new Date(r.receipt_deleted_at).toISOString() : null,
      sale_day: r.sale_day,
      price_review_status: r.price_review_status ?? null,
      payments:
        r.pay_lines && r.pay_lines.length
          ? r.pay_lines
          : [{ method: r.payment_method as LineMethod, amount: r.total, reference: r.payment_reference, cash_received: null, change_given: null, credit_days: null, due_date: null }],
      customer_identification: isCF ? CONSUMIDOR_FINAL_ID : r.customer_identification,
      customer_name: isCF ? "Consumidor final" : r.c_company || [r.c_first, r.c_last].filter(Boolean).join(" ") || r.customer_identification,
    };
  });
}
