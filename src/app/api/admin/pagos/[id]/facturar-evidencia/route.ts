import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { pool } from "@/lib/db";
import { ATTEMPT_COLS, type Attempt } from "@/lib/epayco/attempts";
import { evaluateTrustedWebhook } from "@/lib/epayco/trust";
import { writeLog } from "@/lib/log";
import { isUuid } from "@/lib/sales";
import { transitionSale, type SaleStatus } from "@/lib/sale-states";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 180;

const FROM: SaleStatus[] = ["esperando_pago", "pago_por_revisar", "pago_tardio"];

/**
 * Pagos por revisar → "Facturar con evidencia del webhook" (solo admin, ÚLTIMO RECURSO). Para una venta cuyo pago ePayco avisó como
 * APROBADO con un webhook firmado, pero que nunca se pudo confirmar consultando a ePayco (no llegó la referencia larga).
 * Exige EXACTAMENTE las condiciones de trust.ts sobre el aviso guardado (firma válida registrada, x_cod_response=1,
 * x_cod_transaction_state=1, x_amount = total guardado, COP, x_id_invoice = referencia del intento, x_extra1 = UUID de la venta,
 * x_test_request coherente con EPAYCO_TEST_MODE) y una NOTA obligatoria. Registra quién y cuándo.
 * Una sola factura: la venta se bloquea (FOR UPDATE), el aviso se "reclama" en payment_refs (una vez) y la facturación es idempotente.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req); // /api/admin/*: solo admin
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const note = String(body?.note ?? "").trim().slice(0, 500);
  if (note.length < 5) return NextResponse.json({ error: "Escriba una nota (por qué factura con la evidencia del webhook, p. ej. «verificado en el panel de Davipay»)." }, { status: 400 });

  const c = await pool.connect();
  let local = "";
  try {
    await c.query("BEGIN");
    const s = (
      await c.query<{ status: SaleStatus; local_number: string; total: number; refund_requested_at: Date | null }>(
        "SELECT status, local_number, total::float8 AS total, refund_requested_at FROM sales WHERE id = $1 AND payment_method = 'epayco' FOR UPDATE",
        [id]
      )
    ).rows[0];
    if (!s) {
      await c.query("ROLLBACK");
      return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });
    }
    local = s.local_number;
    if (s.refund_requested_at) {
      await c.query("ROLLBACK");
      return NextResponse.json({ error: "La venta está marcada para reembolso: no se puede facturar" }, { status: 409 });
    }
    if (!FROM.includes(s.status)) {
      await c.query("ROLLBACK");
      return NextResponse.json({ error: `La venta está en estado '${s.status}': ya se resolvió (no se factura otra vez)` }, { status: 409 });
    }
    const att = (
      await c.query<Attempt>(`SELECT ${ATTEMPT_COLS} FROM payment_attempts WHERE sale_id = $1 AND webhook_approved_at IS NOT NULL ORDER BY attempt_no DESC LIMIT 1`, [id])
    ).rows[0];
    if (!att?.webhook_summary) {
      await c.query("ROLLBACK");
      return NextResponse.json({ error: "Esta venta no tiene un aviso firmado de pago aprobado de ePayco: no hay evidencia para facturar." }, { status: 409 });
    }
    const w = att.webhook_summary;
    const lastNo = (await c.query<{ n: number }>("SELECT max(attempt_no)::int AS n FROM payment_attempts WHERE sale_id = $1", [id])).rows[0]?.n ?? 0;
    const ev = evaluateTrustedWebhook(w as unknown as Record<string, string | null>, { id, total: s.total }, { invoice: att.invoice, current: att.attempt_no === lastNo }, { signatureVerified: w.signature_valid === true });
    if (!ev.ok) {
      await c.query("ROLLBACK");
      await writeLog("pago", `${g.user.name} intentó facturar ${local} con la evidencia del webhook, pero no se cumplen las condiciones: ${ev.failed.join("; ")}`, {
        level: "warn", userId: g.user.uid, detail: { sale_id: id, failed: ev.failed },
      });
      return NextResponse.json({ error: `No se puede facturar con esta evidencia: ${ev.failed.join("; ")}.` }, { status: 409 });
    }
    // Reclamo atómico del aviso (el número corto de ePayco): una sola vez, aunque se pulse dos veces o coincida con el webhook/consulta activa
    const claimed = await c.query(
      `INSERT INTO payment_refs (ref_payco, sale_id, outcome, source, reason, amount, detail, finished_at)
       VALUES ($1, $2, 'aprobado', 'admin', $3, $4, $5, now()) ON CONFLICT (ref_payco) DO NOTHING`,
      [
        w.x_ref_payco, id, `Facturado por ${g.user.name} con la evidencia del webhook firmado: ${note}`, s.total,
        JSON.stringify({ x_ref_payco: w.x_ref_payco, transaction_id: w.x_transaction_id, invoice: w.x_id_invoice, amount: Number(w.x_amount), currency: w.x_currency_code, cod_response: 1, response: w.x_response, test_request: w.x_test_request, franchise: w.x_franchise, via: "evidencia_webhook" }),
      ]
    );
    if (!claimed.rowCount) {
      await c.query("ROLLBACK");
      return NextResponse.json({ error: "Ese pago ya se registró (otra persona o el sistema se adelantó)." }, { status: 409 });
    }
    const exec = (t: string, v: unknown[]) => c.query(t, v);
    const moved = await transitionSale(id, [s.status], "pagado", {
      payment_status: "aprobado", payment_failure_reason: null, last_error: null,
      payment_reference: w.x_ref_payco, epayco_transaction_id: w.x_transaction_id || null,
    }, exec);
    if (!moved) {
      await c.query("ROLLBACK");
      return NextResponse.json({ error: "Otra persona ya resolvió esta venta" }, { status: 409 });
    }
    await c.query(
      `UPDATE payment_attempts SET status = 'aprobado', closed_at = COALESCE(closed_at, now()), ref_used = 'firma',
              evidence_by = $2, evidence_at = now(), evidence_note = $3 WHERE id = $1`,
      [att.id, g.user.uid, note]
    );
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }

  await writeLog("pago", `${g.user.name} facturó ${local} con la EVIDENCIA DEL WEBHOOK firmado (sin consulta a ePayco). Nota: ${note}`, {
    level: "warn", userId: g.user.uid, detail: { sale_id: id, via: "evidencia_webhook" },
  });
  const out = await invoiceSale(id, g.user.uid);
  return NextResponse.json({ ok: true, ...out });
}
