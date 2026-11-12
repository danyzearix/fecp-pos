import { NextResponse } from "next/server";
import { attemptLogin, setSessionCookie } from "@/lib/auth";

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ error: "Ingresa correo y contraseña" }, { status: 400 });
  }
  const r = await attemptLogin(email, password);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  await setSessionCookie(r.user);
  return NextResponse.json({ ok: true, user: r.user });
}
