import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { siigo } from "@/lib/siigo/client";

// Catálogos de Siigo para llenar src/config/siigo-map.ts (solo admin):
//   /api/admin/siigo/taxes, /api/admin/siigo/payment-types, /api/admin/siigo/cost-centers,
//   /api/admin/siigo/document-types, /api/admin/siigo/users
const PATHS: Record<string, string> = {
  taxes: "/v1/taxes",
  "payment-types": "/v1/payment-types?document_type=FV",
  "cost-centers": "/v1/cost-centers",
  "document-types": "/v1/document-types?type=FV",
  users: "/v1/users",
};

export async function GET(req: Request, ctx: { params: Promise<{ catalog: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { catalog } = await ctx.params;
  const path = PATHS[catalog];
  if (!path) return NextResponse.json({ error: `Catálogos disponibles: ${Object.keys(PATHS).join(", ")}` }, { status: 404 });
  try {
    return NextResponse.json(await siigo("GET", path));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
