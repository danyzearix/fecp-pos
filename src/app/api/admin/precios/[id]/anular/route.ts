import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { isUuid } from "@/lib/sales";
import { transitionAllowed } from "@/lib/sale-states";

/**
 * "Anular" una venta retenida por precio por revisar (solo admin). EXIGE una nota con el motivo. Una venta anulada NUNCA se
 * factura. El dinero ya se cobró: la venta anulada sale en el cuadre y en los reportes en la línea aparte
 * "Ventas anuladas con dinero cobrado". Queda registrado quién decidió, cuándo y por qué.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 300) : "";
  if (note.length < 5) return NextResponse.json({ error: "Escribe la nota con el motivo de la anulación (mínimo 5 caracteres)." }, { status: 400 });
  if (!transitionAllowed("pending", "anulada") || !transitionAllowed("failed", "anulada")) throw new Error("Transición no permitida");

  const r = await query<{ local_number: string }>(
    `UPDATE sales SET status = 'anulada', price_review_status = 'anulada', price_review_by = $2, price_review_decided_at = now(),
                      price_review_note = $3, last_error = $4
      WHERE id = $1 AND price_review_status = 'pendiente' AND status IN ('pending','failed')
      RETURNING local_number`,
    [id, g.user.uid, note, `Anulada por precio por revisar: ${note}`]
  );
  if (!r.rows[0]) return NextResponse.json({ error: "Esta venta ya no está retenida (alguien ya la decidió) o no existe." }, { status: 409 });
  await writeLog("venta", `${g.user.name} ANULÓ ${r.rows[0].local_number} por precio por revisar`, {
    userId: g.user.uid,
    level: "warn",
    detail: { sale_id: id, note },
  });
  return NextResponse.json({ ok: true });
}
