import { passwordError } from "@/lib/password-rules";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { isRole } from "@/lib/permissions";
import { parseSellerId } from "@/lib/users";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { rows } = await query(
    `SELECT id, name, email, role, active, siigo_seller_id, locked_until, created_at FROM users ORDER BY active DESC, role, name`
  );
  return NextResponse.json({ users: rows, me: g.user.uid });
}

export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 100) : "";
  const email = typeof b?.email === "string" ? b.email.trim().toLowerCase().slice(0, 150) : "";
  const password = typeof b?.password === "string" ? b.password : "";
  const role = b?.role;
  const seller = parseSellerId(b?.siigo_seller_id);

  if (!name) return NextResponse.json({ error: "Escribe el nombre" }, { status: 400 });
  if (!EMAIL_RE.test(email)) return NextResponse.json({ error: "Correo no válido" }, { status: 400 });
  if (!isRole(role)) return NextResponse.json({ error: "Rol no válido" }, { status: 400 });
  // Administrador: mínimo 12 caracteres; cajero y cliente: 8
  const pwdErr = passwordError(role, password);
  if (pwdErr) return NextResponse.json({ error: pwdErr }, { status: 400 });
  if (seller === undefined && b?.siigo_seller_id !== undefined) {
    return NextResponse.json({ error: "El id de vendedor de Siigo debe ser un número" }, { status: 400 });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await query<{ id: number }>(
      `INSERT INTO users (name, email, password_hash, role, siigo_seller_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, hash, role, seller ?? null]
    );
    await writeLog("admin", `Usuario creado: ${email} (${role})`, { userId: g.user.uid, detail: { new_user_id: rows[0].id, role } });
    return NextResponse.json({ ok: true, id: rows[0].id });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return NextResponse.json({ error: "Ya existe un usuario con ese correo" }, { status: 409 });
    throw e;
  }
}
