import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { listWarehouses } from "@/lib/warehouse";

export const dynamic = "force-dynamic";

/**
 * Bodegas de Siigo en vivo (caché de 5 min; ?refresh=1 la ignora). Si Siigo no responde devuelve la última lista guardada con stale=true.
 * SOLO ADMIN (todo /api/admin/* lo exige el proxy y guardApi).
 */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const l = await listWarehouses({ refresh });
  return NextResponse.json(
    { warehouses: l.warehouses, stale: l.stale, error: l.stale ? "Siigo no respondió: se muestra la última lista guardada." : undefined },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** Opción por bodega: ¿su catálogo incluye también los productos de WooCommerce? (por defecto sí) */
export async function PATCH(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const b = (await req.json().catch(() => null)) as { id?: unknown; include_woo?: unknown } | null;
  const id = Number(b?.id);
  if (!Number.isInteger(id) || id <= 0 || typeof b?.include_woo !== "boolean") return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  const r = await query("UPDATE warehouses SET include_woo = $2 WHERE id = $1", [id, b.include_woo]);
  if (!r.rowCount) return NextResponse.json({ error: "Bodega no encontrada" }, { status: 404 });
  await writeLog("admin", `Bodega ${id}: el catálogo ${b.include_woo ? "incluye" : "NO incluye"} los productos de WooCommerce`, {
    userId: g.user.uid,
    detail: { warehouse_id: id, include_woo: b.include_woo },
  });
  return NextResponse.json({ ok: true });
}
