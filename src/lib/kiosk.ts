// Autoservicio: crea la venta (en 'esperando_pago') y la sesión de cobro en ePayco.
// El navegador SOLO manda qué productos y cuántos: precios, IVA y total salen de la base de datos.
import crypto from "node:crypto";
import { pool, query } from "./db";
import { writeLog } from "./log";
import { cartTotals, lineAmounts, type CartLine } from "./money";
import { CONSUMIDOR_FINAL_ID, type CustomerIn } from "./sale-types";
import { parseCustomer, upsertCashierCustomer } from "./sales";
import { resolveSaleCustomer } from "./customer-resolve";
import { transitionSale } from "./sale-states";
import { EpaycoError } from "./epayco/adapter";
import { openAttempt } from "./epayco/attempts";
import { epaycoMissingEnv, getEpaycoConfig } from "./epayco/config";
import { getPosConfig } from "./config";
import { epaycoInvoicingBlocker } from "./siigo/payment";
import { initialChannel, payUrlFor, qrAvailable, type PayChannel } from "./epayco/channel";

export type KioskPayment = {
  saleId: string;
  localNumber: string;
  /** sesión del checkout en pantalla; null si el cobro empieza por QR (la crea el celular) */
  sessionId: string | null;
  total: number;
  expiresAt: string;
  testMode: boolean;
  payToken: string;
  /** enlace público de pago: SOLO si el canal activo es QR */
  payUrl: string | null;
  /** canal abierto: 'qr' (celular) o 'pantalla' (checkout en el equipo). Nunca los dos. */
  channel: PayChannel;
  /** ¿se puede cambiar a QR? (hay dominio público) */
  qrAvailable: boolean;
};
/** Quién crea el cobro: el kiosco (rol cliente) o un empleado desde la caja (cajero/admin). */
export type PaymentSource = "kiosco" | "caja";
export const sourceForRole = (role: string): PaymentSource => (role === "cliente" ? "kiosco" : "caja");

export type KioskPaymentResult = ({ ok: true } & KioskPayment) | { ok: false; status: number; error: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fail = (status: number, error: string): KioskPaymentResult => ({ ok: false, status, error });

export async function createKioskPayment(input: {
  userId: number;
  /** 'kiosco' (por defecto) o 'caja': cambia el prefijo del número, la URL de regreso y el trato del cliente */
  source?: PaymentSource;
  body: unknown;
  /** origen de la petición (p. ej. http://localhost:3000): la respuesta de ePayco vuelve a {origin}/kiosco */
  origin: string;
}): Promise<KioskPaymentResult> {
  const b = (input.body ?? {}) as Record<string, unknown>;
  const source: PaymentSource = input.source ?? "kiosco";
  const cfg = getEpaycoConfig();
  const pos = getPosConfig();

  // ---- ¿Está lista la configuración? Si no, ni se cobra ----
  const unavailable = source === "caja" ? "El pago electrónico no está disponible (revise la configuración de ePayco)." : "El pago electrónico no está disponible. Acérquese a la caja.";
  const where = source === "caja" ? "Cobro electrónico en caja" : "Autoservicio";
  const missing = epaycoMissingEnv();
  if (missing.length) {
    await writeLog("pago", `${where} no disponible: faltan variables ${missing.join(", ")}`, { level: "error", userId: input.userId });
    return fail(503, unavailable);
  }
  const blocker = epaycoInvoicingBlocker(); // no cobrar si luego no se podría facturar
  if (blocker) {
    await writeLog("pago", `${where} bloqueado: ${blocker}`, { level: "error", userId: input.userId });
    return fail(503, unavailable);
  }

  // ---- Productos y cantidades (lo único que acepta del navegador) ----
  if (!Array.isArray(b.items) || b.items.length === 0 || b.items.length > 50) return fail(400, "El carrito está vacío o es demasiado grande");
  const qty = new Map<number, number>();
  for (const raw of b.items) {
    const i = (raw ?? {}) as Record<string, unknown>;
    const id = Number(i.product_id);
    const q = Number(i.quantity);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(q) || q < 1 || q > 99) return fail(400, "Producto o cantidad no válidos");
    qty.set(id, (qty.get(id) ?? 0) + q);
  }
  const prods = await query<{ id: number; sku: string; name: string; price: number; tax_rate: number; prices_include_tax: boolean }>(
    `SELECT id, sku, name, price::float8 AS price, tax_rate, prices_include_tax FROM products
      WHERE id = ANY($1::int[]) AND active AND sku IS NOT NULL AND sku <> ''`,
    [[...qty.keys()]]
  );
  if (prods.rows.length !== qty.size) return fail(400, "Alguno de los productos ya no está disponible");

  const lines: CartLine[] = prods.rows.map((p) => ({
    productId: p.id, sku: p.sku, barcode: null, name: p.name,
    unitPrice: p.price, taxRate: p.tax_rate, includesTax: p.prices_include_tax, qty: qty.get(p.id)!,
  }));
  const totals = cartTotals(lines);
  if (!(totals.total > 0)) return fail(400, "El total debe ser mayor a cero");

  // ---- Cliente ----
  // La caja (cobro electrónico con QR) puede traer clientes sincronizados de Siigo con más tipos de documento; el kiosco no.
  const parsed = parseCustomer(b.customer, { extended: source === "caja" });
  if (typeof parsed === "string") return fail(400, parsed);
  const customer: CustomerIn | null = parsed && parsed.identification !== CONSUMIDOR_FINAL_ID ? parsed : null;
  // El monto ya no decide el tipo de checkout: sin cédula = Consumidor final (aunque pase de 5 UVT) mientras CONSUMIDOR_FINAL_SIN_TOPE
  // sea true. Con false se conserva el tope anterior: por encima de 5 UVT hay que identificar al cliente.
  if (!customer && !pos.consumidorFinalSinTope && totals.subtotal > 5 * pos.uvt) return fail(400, "Esta compra requiere datos completos del cliente");
  const checkoutType: "corto" | "completo" = customer ? "completo" : "corto";
  // El SERVIDOR resuelve al cliente desde la base. Caja: completa solo campos vacíos y exige datos completos. Kiosco: un cliente que ya
  // existe se usa TAL COMO ESTÁ (lo que mande el navegador se ignora); uno nuevo debe traer todos sus datos.
  const rc = await resolveSaleCustomer(customer, { source, require: source === "caja" ? "always" : "new_only" });
  if (!rc.ok) return fail(400, rc.error);
  // Correo para enviar ESTA factura: va en la venta, NO se guarda en el cliente. (En la caja, si no lo escribieron, el del cliente ya guardado.)
  const notifyRaw = typeof b.notify_email === "string" ? b.notify_email.trim().slice(0, 150) : (source === "caja" ? rc.merged?.email : customer?.email) ?? "";
  if (notifyRaw && !EMAIL_RE.test(notifyRaw)) return fail(400, "El correo no es válido");
  const notifyEmail = notifyRaw || null;

  // ---- Canal: caja → QR por defecto; kiosco → en pantalla. Sin dominio público solo hay "pantalla". ----
  const channel = initialChannel(source, b.channel);

  // ---- Guardar la venta en 'esperando_pago' ----
  const saleId = crypto.randomUUID();
  const payToken = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + cfg.expiresMinutes * 60_000);
  const c = customer ?? { id_type: "13", identification: CONSUMIDOR_FINAL_ID, first_name: "Consumidor", last_name: "final" };

  const client = await pool.connect();
  let localNumber = "";
  try {
    await client.query("BEGIN");
    let customerId: number;
    if (source === "caja") {
      // Lo atiende un empleado: igual que una venta normal de caja (completa o actualiza los datos del cliente)
      customerId = await upsertCashierCustomer(client, rc.toStore);
    } else {
      // Privacidad: si el cliente YA existe NO se modifica (nadie puede cambiar los datos de otra persona desde el kiosco)
      await client.query(
        `INSERT INTO customers (id_type, identification, check_digit, first_name, last_name, company_name, email, phone, address, state_code, city_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (identification) DO NOTHING`,
        [
          c.id_type, c.identification, c.check_digit ?? "", c.first_name ?? "", c.last_name ?? "", c.company_name ?? "",
          c.email ?? "", c.phone ?? "", c.address || process.env.POS_ADDRESS || "", c.state_code || pos.defaultStateCode, c.city_code || pos.defaultCityCode,
        ]
      );
      const cust = await client.query<{ id: number }>("SELECT id FROM customers WHERE identification = $1", [c.identification]);
      customerId = cust.rows[0].id;
    }
    const seq = await client.query<{ n: string }>("SELECT nextval('kiosk_sale_seq') AS n");
    localNumber = `${source === "caja" ? "E01" : "K01"}-${String(seq.rows[0].n).padStart(6, "0")}`;

    await client.query(
      `INSERT INTO sales (id, local_number, cashier_id, customer_id, checkout_type, subtotal, tax_total, total, payment_method,
                          status, created_at_device, source, payment_status, payment_expires_at, pay_token, notify_email, pay_channel, pay_channel_changed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'epayco','esperando_pago',now(),$12,'esperando',$9,$10,$11,$13,now())`,
      [saleId, localNumber, input.userId, customerId, checkoutType, totals.subtotal, totals.tax, totals.total, expiresAt, payToken, notifyEmail, source, channel]
    );
    await client.query("INSERT INTO sale_payments (sale_id, method, amount, ord) VALUES ($1,'epayco',$2,1)", [saleId, totals.total]);
    for (const l of lines) {
      await client.query(
        `INSERT INTO sale_items (sale_id, product_id, sku, name, quantity, unit_price, tax_rate, line_total, prices_include_tax)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [saleId, l.productId, l.sku, l.name, l.qty, l.unitPrice, l.taxRate, lineAmounts(l).total, l.includesTax]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // ---- Primer INTENTO de pago con el canal que eligió la persona (el servidor crea la sesión de ePayco AHORA, no antes) ----
  // QR: sin sesión (la crea el celular al abrir /pagar/<código>). Pantalla: sesión de ePayco con la referencia del intento.
  await writeLog("pago", `Cobro creado${source === "caja" ? " en caja" : ""}: ${localNumber} por $${totals.total} (canal: ${channel === "qr" ? "QR en el celular" : "en pantalla"})`, {
    userId: input.userId,
    detail: { sale_id: saleId, source, customer_branch: rc.branch, local_number: localNumber, total: totals.total, channel, test: cfg.testMode, items: lines.length },
  });
  try {
    // El kiosco usa EPAYCO_RESPONSE_URL si existe (o su propia pantalla /kiosco); la caja siempre vuelve a /caja.
    // El kiosco se usa en http://127.0.0.1:3000 (la pantalla /kiosco redirige sola desde localhost).
    const wantedUrl = source === "caja" ? `${input.origin}/caja` : cfg.responseUrl || `${input.origin}/kiosco`;
    const r = await openAttempt({ saleId, channel, userId: input.userId, responseUrl: wantedUrl, where: source === "caja" ? "la caja" : "el kiosco" });
    if (!r.ok) throw new Error(r.error);
    // En pantalla el enlace del celular está CERRADO: no se entrega (se abre solo si se elige QR)
    return {
      ok: true, saleId, localNumber, sessionId: r.sessionId, total: totals.total, expiresAt: expiresAt.toISOString(), testMode: cfg.testMode,
      payToken, payUrl: channel === "qr" ? payUrlFor(payToken) : null, channel, qrAvailable: qrAvailable(),
    };
  } catch (e) {
    const reason = e instanceof EpaycoError ? `No se pudo crear el cobro en ePayco (${e.kind}): ${e.message}` : `Error creando el cobro: ${e instanceof Error ? e.message : e}`;
    await transitionSale(saleId, ["esperando_pago"], "pago_fallido", { payment_status: "rechazado", payment_failure_reason: reason });
    await writeLog("pago", `Cobro ${localNumber} NO se pudo crear: ${reason}`, { level: "error", userId: input.userId, detail: { sale_id: saleId } });
    return fail(502, "No se pudo iniciar el pago. Intente de nuevo o acérquese a la caja.");
  }
}
