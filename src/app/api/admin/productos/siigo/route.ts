import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { getProductSyncStatus, startProductSync } from "@/lib/siigo/product-sync";

export const dynamic = "force-dynamic";

/** Estado de la sincronización de productos de Siigo (la pantalla Admin → Productos lo consulta cada 2 s mientras corre). Solo admin. */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  return NextResponse.json(await getProductSyncStatus(), { headers: { "Cache-Control": "no-store" } });
}

/** Inicia la sincronización (202 enseguida; corre en segundo plano). Un solo candado con WooCommerce: si hay otra en curso → 409. Cuerpo: { kind: "completa" | "existencias" } */
export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const b = (await req.json().catch(() => null)) as { kind?: unknown } | null;
  const kind = b?.kind === "existencias" ? "existencias" : "completa";
  const r = await startProductSync({ kind, trigger: "manual", userId: g.user.uid });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, run_id: r.runId }, { status: 202 });
}
