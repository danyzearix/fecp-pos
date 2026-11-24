import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { writeLog } from "@/lib/log";
import { getSetting, setSetting } from "@/lib/settings";
import { DEFAULT_PRICE_LIST } from "@/lib/siigo/product-sync";
import {
  getDefaultWarehouseId, setDefaultWarehouse, SETTING_SIIGO_INCLUDE_TYPES, SETTING_SIIGO_PRICE_LIST, SETTING_STOCK_SYNC_MINUTES, stockSyncMinutes, warehouseExists,
} from "@/lib/warehouse";

export const dynamic = "force-dynamic";

const TYPES = ["Product", "Service", "ConsumerGood", "FixedAsset"];

/** Configuración del catálogo de Siigo (Admin → Configuración). Solo admin. */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  return NextResponse.json(
    {
      default_warehouse_id: await getDefaultWarehouseId(),
      stock_sync_minutes: await stockSyncMinutes(),
      price_list: (await getSetting(SETTING_SIIGO_PRICE_LIST)) || DEFAULT_PRICE_LIST,
      include_types: ((await getSetting(SETTING_SIIGO_INCLUDE_TYPES)) || "Product").split(",").map((s) => s.trim()).filter(Boolean),
      all_types: TYPES,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
  const done: string[] = [];
  if (b.default_warehouse_id !== undefined) {
    const w = b.default_warehouse_id === null || b.default_warehouse_id === "" ? null : Number(b.default_warehouse_id);
    if (w !== null && (!Number.isInteger(w) || !(await warehouseExists(w)))) return NextResponse.json({ error: "Bodega no válida" }, { status: 400 });
    await setDefaultWarehouse(w, g.user.uid);
    done.push("bodega por defecto");
  }
  if (b.stock_sync_minutes !== undefined) {
    const n = Number(b.stock_sync_minutes);
    if (!Number.isInteger(n) || n < 0 || n > 1440 || (n > 0 && n < 5)) return NextResponse.json({ error: "Las existencias se actualizan cada 5 a 1440 minutos (0 = apagado)" }, { status: 400 });
    await setSetting(SETTING_STOCK_SYNC_MINUTES, String(n));
    done.push("minutos de existencias");
  }
  if (b.price_list !== undefined) {
    const p = typeof b.price_list === "string" ? b.price_list.trim().slice(0, 60) : "";
    if (!p) return NextResponse.json({ error: "Escriba el nombre de la lista de precios de Siigo" }, { status: 400 });
    await setSetting(SETTING_SIIGO_PRICE_LIST, p);
    done.push("lista de precios");
  }
  if (b.include_types !== undefined) {
    const t = Array.isArray(b.include_types) ? b.include_types.filter((x): x is string => typeof x === "string" && TYPES.includes(x)) : [];
    if (!t.length) return NextResponse.json({ error: "Elija al menos un tipo de producto de Siigo" }, { status: 400 });
    await setSetting(SETTING_SIIGO_INCLUDE_TYPES, t.join(","));
    done.push("tipos incluidos");
  }
  if (!done.length) return NextResponse.json({ error: "Nada que cambiar" }, { status: 400 });
  await writeLog("admin", `Catálogo de Siigo: se cambió ${done.join(", ")}`, { userId: g.user.uid, detail: { cambios: done } });
  return NextResponse.json({ ok: true });
}
