import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { writeLog } from "@/lib/log";
import { syncProductsFull } from "@/lib/woo";

export const maxDuration = 300;

// Sincronización COMPLETA (solo admin). Detecta también productos eliminados o despublicados.
export async function POST(req: Request) {
  const g = await guardApi(req); // solo admin (src/lib/permissions.ts)
  if (!g.ok) return g.res;
  const user = g.user;

  try {
    const out = await syncProductsFull(user.uid);
    if (out.status === "busy") {
      return NextResponse.json({ error: "Ya hay una sincronización en curso" }, { status: 409 });
    }
    if (out.status === "ok") return NextResponse.json({ ok: true, ...out.result });
    return NextResponse.json({ error: out.reason }, { status: 409 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeLog("sync", `Sync completa Woo falló: ${msg}`, { level: "error", userId: user.uid, detail: { error: msg } });
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
