import { after, NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { ATTEMPT_COLS, candidatesOf, REF_KIND_TEXT, type Attempt, type RefCandidate } from "@/lib/epayco/attempts";
import { verifyByCandidates, type CandidateRun } from "@/lib/epayco/candidates";
import { getEpaycoConfig } from "@/lib/epayco/config";
import { PaymentInputError } from "@/lib/epayco/process";
import { parseAdminRef, WHERE_LONG_REF } from "@/lib/epayco/ref-input";
import { writeLog } from "@/lib/log";
import { isUuid } from "@/lib/sales";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 60;

const KIND_NAME = { larga: "la referencia larga", corta: "la referencia corta (x_ref_payco)", transaction_id: "el número de transacción (x_transaction_id)", firma: "el aviso firmado" } as const;

/** Mensaje claro para el admin según lo que pasó con la consulta (sin detalles técnicos innecesarios) */
function adminMessage(run: CandidateRun): string {
  const st = run.lookup?.response ? ` (estado en ePayco: ${run.lookup.response})` : "";
  switch (run.outcome) {
    case "pagado":
      return `Pago aprobado y verificado con ${REF_KIND_TEXT[run.used ?? "larga"]}. Se está generando la factura.`;
    case "ya_procesado":
      return "Ese pago ya estaba registrado en esta venta. No se hizo nada más.";
    case "pendiente":
      return `Estado: pendiente en ePayco${st}. Aún no se puede facturar; el sistema lo sigue consultando.`;
    case "rechazado":
      return `Estado: rechazado${st}. No hubo pago.`;
    case "cancelado":
      return `Estado: cancelado por el cliente${st}. No hubo pago.`;
    case "tardio":
      return "El pago está aprobado, pero llegó después de vencer el cobro: quedó como «Pago tardío» arriba para que usted decida.";
    case "duplicado":
      return "Ese pago es un SEGUNDO cobro de una venta ya pagada: quedó en «Pagos duplicados» para reembolsar.";
    case "por_revisar":
      return /monto/i.test(run.reason ?? "")
        ? `El monto no coincide: ${run.reason}. La venta quedó por revisar.`
        : `No coincide algo con la venta: ${run.reason ?? "ver el registro"}. La venta quedó por revisar.`;
    case "en_proceso":
      return "Otra verificación de este mismo pago está en curso. Espere unos segundos y recargue.";
    case "no_verificado": {
      const k = run.tried.map((t) => t.why);
      if (k.includes("network")) return "ePayco no respondió (se esperó 10 segundos). Intente de nuevo en un momento.";
      if (k.includes("http")) return `ePayco respondió con un error${run.lookup?.http ? ` (HTTP ${run.lookup.http})` : ""}. Intente de nuevo en un momento.`;
      return `ePayco no encontró esa referencia. ${WHERE_LONG_REF}`;
    }
    default:
      return run.message;
  }
}

/**
 * Verificar un cobro con una referencia de ePayco (solo admin). Sirve cuando el cliente SÍ pagó pero el sistema nunca recibió la referencia
 * larga (PSE por QR, se cerró el navegador...). Pasa por el MISMO camino de siempre: el servidor consulta a ePayco (máximo 10 s) y valida
 * monto, factura, x_extra1, moneda, modo de prueba y firma; factura una sola vez. Cada verificación queda en el log (tipo de referencia,
 * HTTP, tiempo y resultado; sin llaves ni datos personales).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req); // /api/admin/*: solo admin
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { ref_payco?: unknown } | null;
  const parsed = parseAdminRef(String(body?.ref_payco ?? ""));
  if (!parsed) return NextResponse.json({ error: `No reconozco ese dato. ${WHERE_LONG_REF}` }, { status: 400 });

  const own = await query<{ status: string; local_number: string }>("SELECT status, local_number FROM sales WHERE id = $1 AND payment_method = 'epayco'", [id]);
  if (!own.rows[0]) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
  if (!["esperando_pago", "pago_fallido", "pago_por_revisar"].includes(own.rows[0].status)) {
    return NextResponse.json({ error: `La venta está en estado '${own.rows[0].status}': ya no se puede verificar por referencia` }, { status: 409 });
  }

  const alt = getEpaycoConfig().altRefLookup;
  // Un número (referencia corta o de transacción) NO sirve para consultar a ePayco (salvo EPAYCO_ALT_REF_LOOKUP=true, experimental)
  if (parsed.kind !== "larga" && !alt) {
    await writeLog("pago", `${g.user.name} intentó verificar ${own.rows[0].local_number} con ${KIND_NAME[parsed.kind]}: no sirve para consultar a ePayco`, {
      userId: g.user.uid, detail: { sale_id: id, ref_kind: parsed.kind, ref_len: parsed.ref.length },
    });
    return NextResponse.json({
      outcome: "no_verificado", accepted_kind: null, status: own.rows[0].status,
      message: `Eso parece ${KIND_NAME[parsed.kind]}: con ese dato ePayco no permite consultar el pago. ${WHERE_LONG_REF}`,
    });
  }

  const cands: RefCandidate[] = [{ ref: parsed.ref, kind: parsed.kind }];
  const att = (await query<Attempt>(`SELECT ${ATTEMPT_COLS} FROM payment_attempts WHERE sale_id = $1 ORDER BY (webhook_at IS NOT NULL) DESC, attempt_no DESC LIMIT 1`, [id])).rows[0];
  if (alt) for (const c of att ? candidatesOf(att, true) : []) if (!cands.some((x) => x.ref === c.ref)) cands.push(c);

  try {
    const run = await verifyByCandidates(id, cands, "admin");
    if (!run) return NextResponse.json({ error: "Sin referencia para consultar" }, { status: 400 });
    const message = adminMessage(run);
    await writeLog("pago", `${g.user.name} verificó ${own.rows[0].local_number} con ${KIND_NAME[parsed.kind]}${parsed.source === "enlace" ? " (enlace)" : ""}: ${run.outcome}`, {
      userId: g.user.uid,
      detail: { sale_id: id, outcome: run.outcome, ref_kind: parsed.kind, used: run.used, tried: run.tried, http: run.lookup?.http ?? null, ms: run.lookup?.ms ?? null, error_kind: run.lookup?.error_kind ?? null },
    });
    if (run.startInvoicing) {
      after(() => invoiceSale(id, g.user.uid).catch((e) => writeLog("factura", `Error facturando pago electrónico: ${e instanceof Error ? e.message : e}`, { level: "error", detail: { sale_id: id } })));
    }
    return NextResponse.json({ outcome: run.outcome, status: run.saleStatus, accepted_kind: run.outcome === "no_verificado" ? null : run.used, tried: run.tried, message });
  } catch (e) {
    if (e instanceof PaymentInputError) return NextResponse.json({ error: e.message }, { status: e.status });
    await writeLog("pago", `Error verificando pago por referencia: ${e instanceof Error ? e.message : e}`, { level: "error", userId: g.user.uid, detail: { sale_id: id } });
    return NextResponse.json({ error: "No se pudo verificar el pago" }, { status: 500 });
  }
}
