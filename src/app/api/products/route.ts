import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { loadCatalog } from "@/lib/catalog";

// Catálogo para la caja (se guarda en memoria y en el navegador). Depende de la BODEGA del usuario: el servidor la decide.
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const c = await loadCatalog(g.user.uid, g.user.role, { forKiosk: false });
  return NextResponse.json(c, { headers: { "Cache-Control": "no-store" } });
}
