import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { getCatalogVersion } from "@/lib/catalog-version";
import { writeLog } from "@/lib/log";
import { syncProductsIncremental } from "@/lib/woo";

export const maxDuration = 120;

/**
 * Sincronización INCREMENTAL. La pueden llamar admin y cajero (la caja lo hace cada 10 minutos),
 * pero este endpoint NUNCA ejecuta la sincronización completa.
 * Siempre responde con la versión actual del catálogo para que la caja sepa si debe refrescarse.
 */
export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const user = g.user;

  try {
    const out = await syncProductsIncremental(user.uid);
    const version = await getCatalogVersion();

    if (out.status === "busy") return NextResponse.json({ ok: true, skipped: "busy", version });
    if (out.status === "needs_full") {
      return NextResponse.json({ ok: true, skipped: "needs_full", reason: out.reason, version });
    }
    const { created, updated } = out.result;
    return NextResponse.json({ ok: true, created, updated, changed: created + updated, version });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeLog("sync", `Sync incremental Woo falló: ${msg}`, { level: "error", userId: user.uid, detail: { error: msg } });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
