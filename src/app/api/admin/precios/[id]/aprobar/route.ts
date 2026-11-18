import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { isUuid } from "@/lib/sales";
import { invoiceSale } from "@/lib/siigo/invoice";

export const maxDuration = 180;

/**
 * "Aprobar y facturar" una venta retenida por precio por revisar (solo admin: /api/admin/*).
 * Para cambios legítimos (p. ej. una promoción). La aprobación se toma con un UPDATE atómico: si se pulsa dos veces, la
 * segunda no encuentra la venta retenida y responde 409. La factura usa el flujo de siempre (reclamo atómico + Idempotency-Key),
 * así que nunca se crean dos facturas. Queda atada al admin que decidió.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) : "";

  const r = await query<{ local_number: string }>(
    `UPDATE sales SET price_review_status = 'aprobada', price_review_by = $2, price_review_decided_at = now(),
                      price_review_note = NULLIF($3, ''), last_error = NULL
      WHERE id = $1 AND price_review_status = 'pendiente' AND status IN ('pending','failed')
      RETURNING local_number`,
    [id, g.user.uid, note]
  );
  if (!r.rows[0]) return NextResponse.json({ error: "Esta venta ya no está retenida (alguien ya la decidió) o no existe." }, { status: 409 });
  await writeLog("venta", `${g.user.name} APROBÓ el precio de ${r.rows[0].local_number} y se factura`, {
    userId: g.user.uid,
    detail: { sale_id: id, note: note || null },
  });
  const inv = await invoiceSale(id, g.user.uid);
  return NextResponse.json({ ok: true, status: inv.status, invoice_name: inv.invoice_name, error: inv.error });
}
