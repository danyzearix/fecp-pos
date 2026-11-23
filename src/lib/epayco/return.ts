// RETORNO del navegador del cliente desde ePayco (sobre todo el CELULAR que pagó por QR): /pagar/<código>/retorno?ref_payco=...
// Es el único camino por el que llega la referencia LARGA (24 hex) cuando el pago se hizo fuera del kiosco/caja (el webhook no la trae).
// Se procesa en el SERVIDOR al cargar la página (no depende de JavaScript, de la pestaña ni de cuánto tarde el cliente en volver del banco):
//   1. guarda la referencia en el intento (payment_attempts.ref_payco) en cuanto llega;
//   2. la verifica con ePayco por el camino de siempre (processPayment: x_id_invoice, x_extra1, monto, moneda, modo, firma, una sola factura).
// Llegar aquí NO significa que pagó: solo la consulta a ePayco decide.
import { after } from "next/server";
import { writeLog } from "../log";
import { rateLimited } from "../rate-limit";
import { invoiceSale } from "../siigo/invoice";
import { isShortRef } from "./adapter";
import { attachRef } from "./attempts";
import { processPayment } from "./process";

type Params = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export async function processReturn(sale: { id: string; local_number: string }, code: string, params: Params): Promise<{ ref_kind: "larga" | "corta" | "ninguna" | "invalida"; outcome?: string }> {
  const ref = first(params.ref_payco).trim();
  // Solo NOMBRES de los parámetros que agregó ePayco (nunca valores)
  const names = Object.keys(params).filter((k) => /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 40);
  if (!ref) {
    if (names.length) await writeLog("pago", `Retorno de ePayco para ${sale.local_number} SIN ref_payco`, { level: "warn", detail: { sale_id: sale.id, params: names } });
    return { ref_kind: "ninguna" };
  }
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(ref)) return { ref_kind: "invalida" };
  if (isShortRef(ref) || /^\d+$/.test(ref)) {
    await writeLog("pago", `Retorno de ePayco para ${sale.local_number} con una referencia NUMÉRICA (no es la larga): no se puede consultar`, { level: "warn", detail: { sale_id: sale.id, params: names, ref_len: ref.length } });
    return { ref_kind: "corta" };
  }
  if (rateLimited(`pagar:retorno:${code.slice(0, 12)}`, 20, 10 * 60_000)) return { ref_kind: "larga", outcome: "limite" };

  await attachRef(sale.id, ref).catch(() => {});
  try {
    const r = await processPayment(sale.id, ref, "publica");
    await writeLog("pago", `Retorno del celular de ${sale.local_number} con la referencia larga → ${r.outcome}`, {
      detail: { sale_id: sale.id, outcome: r.outcome, params: names, lookup: r.lookup ?? null },
    });
    if (r.startInvoicing) {
      after(() => invoiceSale(sale.id).catch((e) => writeLog("factura", `Error facturando pago electrónico: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: sale.id } })));
    }
    return { ref_kind: "larga", outcome: r.outcome };
  } catch (e) {
    await writeLog("pago", `Error procesando el retorno de ePayco de ${sale.local_number}: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: sale.id } });
    return { ref_kind: "larga", outcome: "error" };
  }
}
