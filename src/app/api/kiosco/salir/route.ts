import { NextResponse } from "next/server";
import { authorizeKioskExit, clearSessionCookie, guardApi } from "@/lib/auth";

/**
 * Salida del kiosco: pide correo y contraseña de un ADMINISTRADOR y, si son correctos, cierra la sesión del kiosco.
 * Límite: 5 intentos fallidos por kiosco → bloqueo de 10 minutos. Cada intento queda en logs (tipo 'seguridad').
 */
export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const b = (await req.json().catch(() => null)) as { email?: unknown; password?: unknown } | null;
  const email = typeof b?.email === "string" ? b.email : "";
  const password = typeof b?.password === "string" ? b.password : "";
  if (!email || !password) return NextResponse.json({ error: "Escriba correo y contraseña" }, { status: 400 });

  const r = await authorizeKioskExit(g.user.uid, email, password);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
