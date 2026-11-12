import { NextResponse } from "next/server";
import { logSecurityBlock } from "@/lib/security-log";
import { SECURITY_TOKEN_HEADER, securityToken } from "@/lib/security-token";

/** Solo lo llama el proxy (con el token interno). Cualquier otra petición recibe 404. */
export async function POST(req: Request) {
  const expected = await securityToken();
  const got = req.headers.get(SECURITY_TOKEN_HEADER) ?? "";
  if (!expected || got.length !== expected.length || got !== expected) return new NextResponse(null, { status: 404 });

  const b = (await req.json().catch(() => null)) as { userId?: unknown; role?: unknown; method?: unknown; path?: unknown } | null;
  if (!b || typeof b.userId !== "number" || typeof b.role !== "string" || typeof b.method !== "string" || typeof b.path !== "string") {
    return new NextResponse(null, { status: 400 });
  }
  await logSecurityBlock({ userId: b.userId, role: b.role.slice(0, 20), method: b.method, path: b.path, source: "proxy" });
  return new NextResponse(null, { status: 204 });
}
