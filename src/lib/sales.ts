// Servidor: validar y registrar ventas, y leer datos de tirilla.
import type { PoolClient } from "pg";
import { pool, query } from "./db";
import { writeLog } from "./log";
import { cartTotals, lineAmounts, round2 } from "./money";
import { getPosConfig } from "./config";
import { itemToLine } from "./ticket";
import {
  CONSUMIDOR_FINAL_ID,
  ID_TYPES,
  CASHIER_PAYMENT_METHODS,
  requiresReference,
  type CustomerIn,
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

/** Devuelve la venta limpia o un mensaje de error en español. */
export function parseSale(body: unknown): SaleIn | string {
  if (!body || typeof body !== "object") return "Cuerpo inválido";
  const b = body as Record<string, unknown>;

  const id = str(b.id, 40);
  if (!isUuid(id)) return "id de venta inválido (debe ser UUID)";
  const local_number = str(b.local_number, 40);
  if (!local_number) return "Falta el número local";
  const checkout_type = b.checkout_type;
  if (checkout_type !== "corto" && checkout_type !== "completo") return "Tipo de checkout inválido";
  const payment_method = CASHIER_PAYMENT_METHODS.find((m) => m.id === b.payment_method)?.id;
  if (!payment_method) return "Medio de pago inválido";
  const payment_reference = str(b.payment_reference, 60);
  if (requiresReference(payment_method) && !payment_reference) {
    return "Falta la referencia o los últimos dígitos del comprobante de pago";
  }

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

  const created = new Date(str(b.created_at_device, 40));
  const cash = b.cash_received == null ? null : num(b.cash_received);
  if (cash !== null && !(cash >= 0)) return "Valor recibido inválido";

  return {
    id,
    local_number,
    created_at_device: isNaN(created.getTime()) ? new Date().toISOString() : created.toISOString(),
    checkout_type,
    payment_method,
    payment_reference: requiresReference(payment_method) ? payment_reference : null,
    cash_received: payment_method === "efectivo" ? cash : null,
    customer,
    items,
  };
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
export async function createSale(sale: SaleIn, cashierId: number): Promise<CreateSaleResult> {
  const lines = sale.items.map(itemToLine);
  const totals = cartTotals(lines);

  let change: number | null = null;
  if (sale.payment_method === "efectivo") {
    if (sale.cash_received == null || sale.cash_received + 0.005 < totals.total) {
      return { ok: false, error: "El valor recibido es menor al total" };
    }
    change = round2(sale.cash_received - totals.total);
  }

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
                          payment_method, cash_received, change_given, status, created_at_device, payment_reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12,$13)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [
        sale.id, sale.local_number, cashierId, cust.rows[0].id, sale.checkout_type,
        totals.subtotal, totals.tax, totals.total, sale.payment_method,
        sale.cash_received, change, sale.created_at_device, sale.payment_reference,
      ]
    );

    const inserted = (ins.rowCount ?? 0) > 0;
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

    if (inserted) {
      await writeLog("venta", `Venta ${sale.local_number} registrada por $${totals.total}`, {
        userId: cashierId,
        detail: { id: sale.id, total: totals.total, payment: sale.payment_method, items: sale.items.length, checkout: sale.checkout_type },
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

type SaleRow = {
  id: string; local_number: string; status: string; created_at: Date; created_at_device: Date | null;
  subtotal: number; tax_total: number; total: number; payment_method: string; payment_reference: string | null;
  cash_received: number | null; change_given: number | null; invoice_name: string | null; cufe: string | null;
  cashier_name: string; c_first: string | null; c_last: string | null; c_company: string | null; c_ident: string | null;
};

export async function getTicketData(id: string): Promise<TicketData | null> {
  const { rows } = await query<SaleRow>(
    `SELECT s.id, s.local_number, s.status, s.created_at, s.created_at_device,
            s.subtotal::float8 AS subtotal, s.tax_total::float8 AS tax_total, s.total::float8 AS total,
            s.payment_method, s.payment_reference, s.cash_received::float8 AS cash_received, s.change_given::float8 AS change_given,
            s.invoice_name, s.cufe, u.name AS cashier_name,
            c.first_name AS c_first, c.last_name AS c_last, c.company_name AS c_company, c.identification AS c_ident
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
};

export async function listSales(date: string, cashierId: number | null): Promise<SaleListRow[]> {
  const { rows } = await query<SaleListRow & { c_first: string | null; c_last: string | null; c_company: string | null }>(
    `SELECT s.id, s.local_number, s.invoice_name, s.total::float8 AS total, s.payment_method, s.payment_reference,
            s.status, s.last_error, COALESCE(s.created_at_device, s.created_at) AS created_at, u.name AS cashier_name,
            c.identification AS customer_identification, c.first_name AS c_first, c.last_name AS c_last, c.company_name AS c_company
       FROM sales s
       JOIN users u ON u.id = s.cashier_id
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE ${SALE_DAY_SQL} = $1::date AND ($2::int IS NULL OR s.cashier_id = $2)
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
      customer_identification: isCF ? CONSUMIDOR_FINAL_ID : r.customer_identification,
      customer_name: isCF ? "Consumidor final" : r.c_company || [r.c_first, r.c_last].filter(Boolean).join(" ") || r.customer_identification,
    };
  });
}
