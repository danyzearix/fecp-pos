import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { loadCatalog } from "@/lib/catalog";

/** Catálogo del kiosco: solo productos activos CON SKU y de la bodega fija del usuario (el cliente no la ve ni la cambia). Los precios son informativos; el cobro los recalcula. */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const c = await loadCatalog(g.user.uid, g.user.role, { forKiosk: true });
  return NextResponse.json({ products: c.products }, { headers: { "Cache-Control": "no-store" } });
}
