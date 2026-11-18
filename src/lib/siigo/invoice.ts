// Facturación en Siigo. Regla de oro: NUNCA facturar dos veces. Tres protecciones:
//  1) Reclamo atómico en Postgres (UPDATE ... WHERE status IN (...) RETURNING): solo un proceso factura cada venta.
//  2) Idempotency-Key = UUID de la venta: si el POST se repite, Siigo devuelve la factura ya creada.
//  3) Si no se sabe si la factura se creó (timeout/red), la venta queda en 'revisar' y NO se reintenta sola:
//     primero se busca en Siigo una factura con el UUID en observations.
import {
  SIIGO_COST_CENTER,
  SIIGO_EXEMPT_TAX_ID,
  SIIGO_INVOICE_TIMEOUT_MS,
  SIIGO_POLL_ATTEMPTS,
  SIIGO_POLL_INTERVAL_MS,
  SIIGO_TAX_ID_BY_RATE,
} from "@/config/siigo-map";
import { query } from "../db";
import { writeLog } from "../log";
import type { LineMethod } from "../payments";
import { INVOICEABLE } from "../sale-states";
import { creditInvoicingBlocker, epaycoInvoicingBlocker } from "./payment";
import { buildObservations, buildSiigoPayments, PaymentsMismatchError, type SalePayLine } from "./payment-body";
import { CONSUMIDOR_FINAL_ID } from "../sale-types";
import { siigo, SiigoHttpError, SiigoNetworkError } from "./client";
import { ensureSiigoCustomer, type CustomerRow } from "./customers";

type SaleRow = {
  id: string;
  local_number: string;
  cashier_id: number;
  customer_id: number;
  total: string;
  payment_method: string; // el medio de la única línea, o "mixto" (las líneas están en sale_payments)
  payment_reference: string | null;
  siigo_invoice_id: string | null;
  created_at: Date;
};

type SiigoInvoice = {
  id: string;
  name?: string;
  prefix?: string;
  number?: number;
  observations?: string;
  total?: number;
  stamp?: { status?: string; cufe?: string; errors?: unknown; observations?: string };
};

export type InvoiceOutcome = { status: string; invoice_name: string | null; error: string | null };

export const isTestMode = () => process.env.SIIGO_TEST_MODE === "true";

/** En modo prueba: documento NO electrónico (6503), sin envío a la DIAN. */
function documentId() {
  const raw = isTestMode() ? process.env.SIIGO_TEST_DOCUMENT_ID : process.env.SIIGO_DOCUMENT_ID;
  const n = Number(raw);
  if (!n) throw new Error(isTestMode() ? "Falta SIIGO_TEST_DOCUMENT_ID en .env.local" : "Falta SIIGO_DOCUMENT_ID en .env.local");
  return n;
}

/** Siigo: alfanumérico, máximo 30 caracteres */
export const idempotencyKey = (saleId: string) => saleId.replace(/-/g, "").slice(0, 30);

const todayBogota = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const invoiceLabel = (inv: SiigoInvoice) => (inv.prefix && inv.number != null ? `${inv.prefix}${inv.number}` : inv.name ?? inv.id);

async function claim(saleId: string, from: string[]): Promise<SaleRow | null> {
  const { rows } = await query<SaleRow>(
    // Una venta retenida por "precio por revisar" NUNCA se reclama para facturar (segunda capa: aunque alguien se saltara el
    // chequeo de invoiceSale, este UPDATE no la toma). Solo se factura desde Admin → Precios por revisar, tras aprobarla.
    `UPDATE sales SET status = 'invoicing', invoicing_started_at = now(), last_error = NULL
      WHERE id = $1 AND status = ANY($2::text[]) AND price_review_status IS DISTINCT FROM 'pendiente'
      RETURNING id, local_number, cashier_id, customer_id, total, payment_method, payment_reference, siigo_invoice_id, created_at`,
    [saleId, from]
  );
  return rows[0] ?? null;
}

async function current(saleId: string): Promise<InvoiceOutcome> {
  const { rows } = await query<{ status: string; invoice_name: string | null; last_error: string | null }>(
    "SELECT status, invoice_name, last_error FROM sales WHERE id = $1",
    [saleId]
  );
  const r = rows[0];
  return { status: r?.status ?? "desconocido", invoice_name: r?.invoice_name ?? null, error: r?.last_error ?? null };
}

async function setResult(
  saleId: string,
  status: string,
  f: { error?: string | null; inv?: SiigoInvoice | null }
): Promise<InvoiceOutcome> {
  const inv = f.inv ?? null;
  const name = inv ? invoiceLabel(inv) : null;
  await query(
    `UPDATE sales SET status = $2, last_error = $3,
            siigo_invoice_id = COALESCE($4, siigo_invoice_id), invoice_name = COALESCE($5, invoice_name),
            cufe = COALESCE($6, cufe), raw_response = COALESCE($7, raw_response)
      WHERE id = $1`,
    [saleId, status, f.error ?? null, inv?.id ?? null, name, inv?.stamp?.cufe || null, inv ? JSON.stringify(inv) : null]
  );
  return { status, invoice_name: name, error: f.error ?? null };
}

/** Arma el cuerpo de POST /v1/invoices */
async function buildInvoiceBody(sale: SaleRow) {
  const test = isTestMode();

  const cust = await query<CustomerRow>("SELECT * FROM customers WHERE id = $1", [sale.customer_id]);
  const customer = cust.rows[0];
  if (!customer) throw new Error("La venta no tiene cliente");

  const seller = await query<{ siigo_seller_id: number | null }>("SELECT siigo_seller_id FROM users WHERE id = $1", [sale.cashier_id]);
  const sellerId = seller.rows[0]?.siigo_seller_id ?? (Number(process.env.SIIGO_SELLER_ID) || null);
  if (!sellerId) throw new Error("El cajero no tiene siigo_seller_id y falta SIIGO_SELLER_ID en .env.local");

  const items = await query<{
    sku: string; quantity: string; unit_price: string; tax_rate: number; prices_include_tax: boolean; siigo_tax_class: string | null;
  }>(
    `SELECT si.sku, si.quantity, si.unit_price, si.tax_rate, si.prices_include_tax, p.siigo_tax_class
       FROM sale_items si LEFT JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1 ORDER BY si.id`,
    [sale.id]
  );

  const siigoItems = items.rows.map((i) => {
    const rate = Number(i.tax_rate);
    const unit = Number(i.unit_price);
    let taxes: { id: number }[] | undefined;
    if (rate === 0) {
      // Excluido: sin arreglo taxes. Exento (o sin clasificar): IVA 0%.
      taxes = i.siigo_tax_class === "Excluded" ? undefined : [{ id: SIIGO_EXEMPT_TAX_ID }];
    } else {
      const id = SIIGO_TAX_ID_BY_RATE[rate];
      if (!id) throw new Error(`No hay id de impuesto de Siigo para la tarifa ${rate}% (src/config/siigo-map.ts)`);
      taxes = [{ id }];
    }
    const item: Record<string, unknown> = { code: i.sku, quantity: Number(i.quantity) };
    if (i.prices_include_tax) {
      // taxed_price = precio con IVA incluido; Siigo calcula la base. price se envía igual por ser obligatorio.
      item.price = Math.round((unit / (1 + rate / 100)) * 1e6) / 1e6;
      item.taxed_price = unit;
    } else {
      item.price = unit;
    }
    if (taxes) item.taxes = taxes;
    return item;
  });

  // ---- Pagos: UNO por cada línea de sale_payments, con el id de Siigo según el medio ----
  const pl = await query<{ method: LineMethod; amount: string; reference: string | null; credit_days: number | null; due_date: string | null }>(
    `SELECT method, amount, COALESCE(reference, CASE WHEN method = 'epayco' THEN $2 END) AS reference, credit_days, to_char(due_date, 'YYYY-MM-DD') AS due_date
       FROM sale_payments WHERE sale_id = $1 ORDER BY ord`,
    [sale.id, sale.payment_reference]
  );
  const lines: SalePayLine[] = pl.rows.map((r) => ({ method: r.method, amount: Number(r.amount), reference: r.reference, credit_days: r.credit_days, due_date: r.due_date }));
  // Si la suma no coincide con el total, lanza PaymentsMismatchError ANTES de enviar nada: la venta queda en revisión con el motivo
  const payments = buildSiigoPayments(lines, Number(sale.total));
  const obs = buildObservations({ saleId: sale.id, lines, test });

  const hasEmail = !!customer.email && customer.identification !== CONSUMIDOR_FINAL_ID;

  return {
    customer,
    body: {
      document: { id: documentId() },
      date: todayBogota(),
      customer: { identification: customer.identification, branch_office: 0 },
      cost_center: SIIGO_COST_CENTER,
      seller: sellerId,
      stamp: { send: !test },
      mail: { send: !test && hasEmail },
      observations: obs,
      items: siigoItems,
      payments,
    },
  };
}

/** Con la factura creada: esperar la aceptación DIAN (si no es prueba) y guardar el resultado. */
async function finalize(sale: SaleRow, created: SiigoInvoice, userId: number | undefined, request: unknown): Promise<InvoiceOutcome> {
  const test = isTestMode();

  if (test) {
    const out = await setResult(sale.id, "invoiced", { inv: created });
    await writeLog("factura", `Documento de PRUEBA creado en Siigo: ${invoiceLabel(created)} (venta ${sale.local_number})`, {
      level: "warn",
      userId,
      detail: {
        test_document: true, sale_id: sale.id, local_number: sale.local_number, total: Number(sale.total),
        siigo_invoice_id: created.id, siigo_name: created.name, request, response: created,
      },
    });
    return out;
  }

  let inv = created;
  for (let i = 0; i < SIIGO_POLL_ATTEMPTS && inv.stamp?.status !== "Accepted" && inv.stamp?.status !== "Rejected"; i++) {
    await sleep(SIIGO_POLL_INTERVAL_MS);
    try {
      inv = await siigo<SiigoInvoice>("GET", `/v1/invoices/${inv.id}`);
    } catch {
      break; // se guarda el id; la verificación posterior la consulta
    }
  }

  const st = inv.stamp?.status;
  if (st === "Accepted" && inv.stamp?.cufe) {
    const out = await setResult(sale.id, "invoiced", { inv });
    await writeLog("factura", `Factura ${out.invoice_name} aceptada por la DIAN (venta ${sale.local_number})`, {
      userId,
      detail: { sale_id: sale.id, siigo_invoice_id: inv.id, request, response: inv },
    });
    return out;
  }

  let err: string;
  if (st === "Rejected") {
    let detail: unknown = inv.stamp?.errors;
    try {
      detail = await siigo("GET", `/v1/invoices/${inv.id}/stamp/errors`);
    } catch {}
    err = `La DIAN rechazó la factura ${invoiceLabel(inv)}. Corregir y reenviar desde Siigo Nube. ${JSON.stringify(detail ?? "").slice(0, 400)}`;
  } else {
    err = `Factura ${invoiceLabel(inv)} creada en Siigo pero la DIAN aún no la confirma (estado: ${st ?? "sin estado"}). Verificar más tarde.`;
  }
  const out = await setResult(sale.id, "revisar", { inv, error: err });
  await writeLog("factura", err, { level: "warn", userId, detail: { sale_id: sale.id, siigo_invoice_id: inv.id, request, response: inv } });
  return out;
}

async function fail(sale: SaleRow, e: unknown, posted: boolean, userId: number | undefined, request: unknown): Promise<InvoiceOutcome> {
  let status: "failed" | "revisar";
  let msg: string;
  if (e instanceof PaymentsMismatchError) {
    // Nunca se envió nada a Siigo. Queda en "revisar" con el motivo (no se reintenta a ciegas).
    status = "revisar";
    msg = e.message;
  } else if (e instanceof SiigoNetworkError) {
    status = posted ? "revisar" : "failed";
    msg = posted ? `No se sabe si Siigo creó la factura: ${e.message}` : e.message;
  } else if (e instanceof SiigoHttpError) {
    status = posted && e.status >= 500 ? "revisar" : "failed";
    msg = `Siigo ${e.status}: ${e.message}`;
  } else {
    status = "failed";
    msg = e instanceof Error ? e.message : String(e);
  }
  await writeLog("factura", `Facturación de ${sale.local_number} → ${status}: ${msg}`, {
    level: "error",
    userId,
    detail: {
      sale_id: sale.id,
      status,
      error: msg,
      http_status: e instanceof SiigoHttpError ? e.status : null,
      siigo_body: e instanceof SiigoHttpError ? e.body : null,
      request,
    },
  });
  return setResult(sale.id, status, { error: msg });
}

export const STUCK_INVOICING_MINUTES = 10;

/**
 * Una venta en 'invoicing' por más de 10 minutos (servidor caído o reiniciado a mitad de facturar) pasa a 'revisar':
 * no se sabe si Siigo la creó, así que NO se reintenta sola; un admin la verifica por UUID.
 * Se ejecuta al listar ventas, al abrir configuración y antes de cada facturación.
 */
export async function sweepStuckInvoicing(): Promise<number> {
  const { rows } = await query<{ id: string; local_number: string }>(
    `UPDATE sales SET status = 'revisar',
            last_error = 'Se quedó facturando más de ${STUCK_INVOICING_MINUTES} minutos (¿se reinició el servidor?). Verificar en Siigo antes de reintentar.'
      WHERE status = 'invoicing'
        AND (invoicing_started_at IS NULL OR invoicing_started_at < now() - interval '${STUCK_INVOICING_MINUTES} minutes')
      RETURNING id, local_number`
  );
  for (const r of rows) {
    await writeLog("factura", `Venta ${r.local_number} trabada en 'invoicing' → pasa a 'revisar'`, { level: "warn", detail: { sale_id: r.id } });
  }
  return rows.length;
}

/** Factura una venta en estado 'pending', 'failed' o 'pagado'. Si otra petición ya la está facturando, no hace nada. */
export async function invoiceSale(saleId: string, userId?: number): Promise<InvoiceOutcome> {
  await sweepStuckInvoicing().catch(() => {});

  // Venta retenida por precio por revisar: no se factura ni se reintenta (ni sola ni desde el botón de /ventas).
  // La decide un admin en Admin → Precios por revisar ("Aprobar y facturar" o "Anular").
  const held = await query<{ held: boolean }>("SELECT price_review_status = 'pendiente' AS held FROM sales WHERE id = $1", [saleId]);
  if (held.rows[0]?.held) {
    await writeLog("factura", `Venta ${saleId}: NO se factura, está retenida por precio por revisar`, { level: "warn", userId, detail: { sale_id: saleId } });
    return current(saleId);
  }

  // Crédito FECP: con SIIGO_TEST_MODE=false y sin SIIGO_PAYMENT_CREDITO_ID no se factura (el id por defecto es solo de pruebas).
  // La venta se queda como está (no se reclama) y el motivo queda en last_error y en /admin/configuracion.
  const hasCredit = await query<{ c: boolean; status: string }>(
    "SELECT EXISTS (SELECT 1 FROM sale_payments WHERE sale_id = $1 AND method = 'credito_fecp') AS c, (SELECT status FROM sales WHERE id = $1) AS status",
    [saleId]
  );
  if (hasCredit.rows[0]?.c && INVOICEABLE.includes(hasCredit.rows[0].status as never)) {
    const blocker = creditInvoicingBlocker();
    if (blocker) {
      await query("UPDATE sales SET last_error = $2 WHERE id = $1", [saleId, blocker]);
      await writeLog("factura", `Venta ${saleId}: NO se factura el Crédito FECP. ${blocker}`, { level: "error", userId, detail: { sale_id: saleId, blocker } });
      return current(saleId);
    }
  }

  // Pago electrónico: no se factura si la configuración no es segura (ver src/lib/siigo/payment.ts).
  // La venta se queda como está (no se reclama) y el motivo queda en last_error y en /admin/configuracion.
  const pm = await query<{ payment_method: string; status: string }>("SELECT payment_method, status FROM sales WHERE id = $1", [saleId]);
  if (pm.rows[0]?.payment_method === "epayco" && INVOICEABLE.includes(pm.rows[0].status as never)) {
    const blocker = epaycoInvoicingBlocker();
    if (blocker) {
      await query("UPDATE sales SET last_error = $2 WHERE id = $1", [saleId, blocker]);
      await writeLog("factura", `Venta ${saleId}: NO se factura el pago electrónico. ${blocker}`, {
        level: "error",
        userId,
        detail: { sale_id: saleId, blocker },
      });
      return current(saleId);
    }
  }

  const sale = await claim(saleId, INVOICEABLE);
  if (!sale) return current(saleId);

  let posted = false;
  let request: unknown = null;
  try {
    const { customer, body } = await buildInvoiceBody(sale);
    request = body;
    await ensureSiigoCustomer(customer);
    posted = true; // desde aquí, un timeout significa "no se sabe si se creó"
    const created = await siigo<SiigoInvoice>("POST", "/v1/invoices", {
      body,
      timeoutMs: SIIGO_INVOICE_TIMEOUT_MS,
      idempotencyKey: idempotencyKey(sale.id),
    });
    return await finalize(sale, created, userId, request);
  } catch (e) {
    return fail(sale, e, posted, userId, request);
  }
}

/**
 * Verificación de una venta en 'revisar'. Si ya tiene id de Siigo, lo consulta.
 * Si no, busca en Siigo una factura con el UUID en observations: si existe la vincula; si no, pasa a 'failed'.
 */
export async function reconcileSale(saleId: string, userId?: number): Promise<InvoiceOutcome> {
  const sale = await claim(saleId, ["revisar"]);
  if (!sale) return current(saleId);

  try {
    let found: SiigoInvoice | null = null;
    if (sale.siigo_invoice_id) {
      found = await siigo<SiigoInvoice>("GET", `/v1/invoices/${sale.siigo_invoice_id}`);
    } else {
      const cust = await query<{ identification: string }>("SELECT identification FROM customers WHERE id = $1", [sale.customer_id]);
      const since = new Date(sale.created_at.getTime() - 24 * 3600_000);
      const createdStart = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(since);
      for (let page = 1; page <= 50 && !found; page++) {
        const qs = new URLSearchParams({
          document_id: String(documentId()),
          customer_identification: cust.rows[0]?.identification ?? "",
          created_start: createdStart,
          page: String(page),
          page_size: "100",
        });
        const r = await siigo<{ results?: SiigoInvoice[]; pagination?: { total_results: number } }>("GET", `/v1/invoices?${qs}`);
        found = r.results?.find((x) => (x.observations ?? "").includes(sale.id)) ?? null;
        if (!r.results?.length || page * 100 >= (r.pagination?.total_results ?? 0)) break;
      }
      if (found) found = await siigo<SiigoInvoice>("GET", `/v1/invoices/${found.id}`);
    }

    if (!found) {
      const msg = "Verificado en Siigo: la factura NO existe. Se puede reintentar la facturación.";
      await writeLog("factura", `Venta ${sale.local_number}: ${msg}`, { level: "warn", userId, detail: { sale_id: sale.id } });
      return setResult(sale.id, "failed", { error: msg });
    }
    await writeLog("factura", `Venta ${sale.local_number}: encontrada en Siigo (${invoiceLabel(found)}), se vincula`, {
      userId,
      detail: { sale_id: sale.id, siigo_invoice_id: found.id },
    });
    return finalize(sale, found, userId, { reconcile: true });
  } catch (e) {
    const msg = `No se pudo verificar en Siigo: ${e instanceof Error ? e.message : e}`;
    await writeLog("factura", `Venta ${sale.local_number}: ${msg}`, { level: "error", userId, detail: { sale_id: sale.id, error: msg } });
    return setResult(sale.id, "revisar", { error: msg }); // sigue en revisar: nunca se reintenta a ciegas
  }
}
