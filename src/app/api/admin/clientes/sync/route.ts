import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { getSyncStatus, startCustomerSync } from "@/lib/siigo/customer-sync";

export const dynamic = "force-dynamic";

// SOLO ADMIN: todo /api/admin/* lo exige el proxy y además guardApi (src/lib/permissions.ts). Un cajero o el kiosco reciben 403.

/** Estado de la sincronización de clientes (la pantalla Admin → Clientes lo consulta cada 2 s mientras corre). */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  return NextResponse.json(await getSyncStatus(), { headers: { "Cache-Control": "no-store" } });
}

/**
 * Inicia o retoma la sincronización. Responde 202 enseguida (corre en segundo plano). Una sola a la vez: si ya hay una, 409.
 * Cuerpo opcional: { full: true } = recarga completa (descarta una corrida caída y vuelve a traer todo).
 */
export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const body = (await req.json().catch(() => null)) as { full?: unknown } | null;
  const r = await startCustomerSync({ userId: g.user.uid, userName: g.user.name, full: body?.full === true });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, run_id: r.runId, resumed: r.resumed, mode: r.mode }, { status: 202 });
}
