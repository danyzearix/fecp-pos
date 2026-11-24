import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { effectiveWarehouse, setSessionWarehouse, storedWarehouses, warehouseExists } from "@/lib/warehouse";

export const dynamic = "force-dynamic";

/** Bodega con la que vende el admin en su sesión de caja ("Vendiendo desde: …") y las bodegas activas para cambiarla. Solo admin. */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const [eff, list] = await Promise.all([effectiveWarehouse(g.user.uid, g.user.role), storedWarehouses()]);
  return NextResponse.json({ current: eff, warehouses: list.filter((w) => w.active) }, { headers: { "Cache-Control": "no-store" } });
}

/** Cambia la bodega de MI sesión (warehouse_id = null → vuelvo a la mía). Queda en el log quién cambió y a cuál. */
export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const b = (await req.json().catch(() => null)) as { warehouse_id?: unknown } | null;
  const w = b?.warehouse_id === null ? null : Number(b?.warehouse_id);
  if (w !== null && (!Number.isInteger(w) || !(await warehouseExists(w)))) return NextResponse.json({ error: "Bodega no válida" }, { status: 400 });
  const current = await setSessionWarehouse(g.user.uid, w);
  return NextResponse.json({ ok: true, current });
}
