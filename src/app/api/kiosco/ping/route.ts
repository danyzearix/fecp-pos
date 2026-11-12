import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";

/** Latido: el kiosco lo consulta cada pocos segundos; si falla, se deshabilita ("Autoservicio no disponible"). */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
