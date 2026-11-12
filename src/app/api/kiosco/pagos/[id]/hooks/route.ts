import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { sourceForRole } from "@/lib/kiosk";
import { isUuid } from "@/lib/sales";

/**
 * Diagnóstico: el kiosco avisa qué hook de ePayco se disparó y la FORMA del objeto que recibió
 * (solo nombres de campos, nunca valores). La documentación de ePayco no dice cómo viene el ref_payco dentro de los
 * hooks; este registro (tipo 'pago') permite ver en /admin/logs qué manda realmente.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const own = await query("SELECT 1 FROM sales WHERE id = $1 AND source = $3 AND cashier_id = $2", [id, g.user.uid, sourceForRole(g.user.role)]);
  if (!own.rowCount) return NextResponse.json({ error: "Venta no encontrada" }, { status: 404 });

  const b = (await req.json().catch(() => null)) as { hook?: unknown; keys?: unknown; refFound?: unknown } | null;
  const hook = typeof b?.hook === "string" ? b.hook.slice(0, 20) : "?";
  const keys = Array.isArray(b?.keys) ? b!.keys.filter((k): k is string => typeof k === "string").slice(0, 80).map((k) => k.slice(0, 60)) : [];
  await writeLog("pago", `Hook de ePayco en el kiosco: ${hook} (ref_payco ${b?.refFound ? "encontrado" : "NO encontrado"})`, {
    userId: g.user.uid,
    detail: { sale_id: id, hook, ref_encontrado: !!b?.refFound, campos: keys },
  });
  return NextResponse.json({ ok: true });
}
