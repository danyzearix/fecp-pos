import { after, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { expectedSignature, EpaycoError, signatureMatches } from "@/lib/epayco/adapter";
import { publicModeEnabled } from "@/lib/epayco/config";
import { PaymentInputError, processPayment } from "@/lib/epayco/process";
import { writeLog } from "@/lib/log";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 60;

/**
 * WEBHOOK de confirmación de ePayco (servidor a servidor). APAGADO mientras APP_PUBLIC_URL esté vacío (modo local).
 *  - Exige x_signature válida (SHA-256 con P_CUST_ID_CLIENTE y P_KEY).
 *  - Aun con firma válida NO confía en el contenido: ubica la venta por x_id_invoice y vuelve a consultar a ePayco
 *    con el ref_payco (mismo camino que el kiosco: monto, invoice, modo de prueba, estado).
 *  - Idempotente: ePayco puede reintentar; cada ref_payco se procesa una sola vez.
 *  - Responde 200 rápido y sin redirecciones (requisito de ePayco); la facturación corre después.
 */
async function handle(req: Request) {
  if (!publicModeEnabled()) return new NextResponse(null, { status: 404 });

  // Los datos pueden llegar por GET (query) o POST (form o JSON)
  const url = new URL(req.url);
  const f: Record<string, string> = Object.fromEntries(url.searchParams.entries());
  if (req.method === "POST") {
    const ct = req.headers.get("content-type") ?? "";
    try {
      if (ct.includes("application/json")) {
        const j = await req.json();
        if (j && typeof j === "object") for (const [k, v] of Object.entries(j)) if (typeof v === "string" || typeof v === "number") f[k] = String(v);
      } else {
        for (const [k, v] of (await req.formData()).entries()) if (typeof v === "string") f[k] = v;
      }
    } catch {
      return new NextResponse("Cuerpo inválido", { status: 400 });
    }
  }

  const ref = f.x_ref_payco ?? ""; // número corto: entra en la firma
  // Para CONSULTAR a ePayco hace falta el id largo (ref_payco); con el número corto la consulta falla
  const lookupRef = f.ref_payco || f.x_ref_payco || "";
  const txId = f.x_transaction_id ?? "";
  const amount = f.x_amount ?? "";
  const currency = f.x_currency_code ?? "";
  const sig = f.x_signature ?? "";
  const invoice = f.x_id_invoice ?? f.x_id_factura ?? "";
  // Se registra lo mínimo (nunca la firma ni llaves)
  const seen = { ref_payco: ref, invoice, amount, response: f.x_response ?? null, test: f.x_test_request ?? null };

  if (!ref || !txId || !amount || !currency || !sig || !invoice) {
    await writeLog("pago", "Webhook ePayco con campos incompletos", { level: "warn", detail: seen });
    return new NextResponse("Campos incompletos", { status: 400 });
  }

  let valid = false;
  try {
    valid = signatureMatches(sig, expectedSignature({ ref, transactionId: txId, amountRaw: amount, currency }));
  } catch (e) {
    await writeLog("pago", `Webhook ePayco no se pudo validar: ${e instanceof EpaycoError ? e.message : "error"}`, { level: "error", detail: seen });
    return new NextResponse("Configuración incompleta", { status: 500 }); // ePayco reintentará
  }
  if (!valid) {
    await writeLog("pago", "Webhook ePayco con FIRMA INVÁLIDA (rechazado)", { level: "error", detail: seen });
    return new NextResponse("Firma inválida", { status: 400 });
  }

  const sale = await query<{ id: string }>("SELECT id FROM sales WHERE local_number = $1 AND source IN ('kiosco','caja') AND payment_method = 'epayco'", [invoice]);
  if (!sale.rows[0]) {
    await writeLog("pago", `Webhook ePayco para un invoice desconocido (${invoice})`, { level: "warn", detail: seen });
    return new NextResponse("OK", { status: 200 }); // 200 para que no reintente eternamente
  }
  const saleId = sale.rows[0].id;
  await writeLog("pago", `Webhook ePayco recibido para ${invoice}`, { detail: { sale_id: saleId, ...seen } });

  try {
    const r = await processPayment(saleId, lookupRef, "webhook");
    if (r.startInvoicing) {
      after(() => invoiceSale(saleId).catch((e) => writeLog("factura", `Error facturando pago electrónico: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: saleId } })));
    }
  } catch (e) {
    if (e instanceof PaymentInputError) return new NextResponse("OK", { status: 200 });
    await writeLog("pago", `Error procesando webhook: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: saleId, ref_payco: ref } });
    return new NextResponse("Error", { status: 500 }); // ePayco reintentará
  }
  return new NextResponse("OK", { status: 200 });
}

export const GET = handle;
export const POST = handle;
