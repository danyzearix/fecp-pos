import { passwordError } from "@/lib/password-rules";
import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { pool, query } from "@/lib/db";
import { writeLog } from "@/lib/log";
import { isRole } from "@/lib/permissions";
import { parseSellerId } from "@/lib/users";
import { assignUserWarehouse, warehouseExists } from "@/lib/warehouse";

const ADMIN_LOCK_KEY = 727002; // candado para cambios que afectan a los administradores

/**
 * Editar un usuario: nombre, rol, activo/inactivo, siigo_seller_id y/o restablecer contraseña.
 * Reglas: no puedes desactivarte ni cambiarte el rol a ti mismo, y siempre debe quedar al menos un admin activo.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "id inválido" }, { status: 400 });

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });

  const cur = (await query<{ role: string; active: boolean; email: string }>("SELECT role, active, email FROM users WHERE id = $1", [id])).rows[0];
  if (!cur) return NextResponse.json({ error: "Usuario no encontrado" }, { status: 404 });

  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  const changes: string[] = [];

  if (typeof b.name === "string") {
    const name = b.name.trim().slice(0, 100);
    if (!name) return NextResponse.json({ error: "El nombre no puede estar vacío" }, { status: 400 });
    add("name", name);
    changes.push("nombre");
  }
  if (b.role !== undefined) {
    if (!isRole(b.role)) return NextResponse.json({ error: "Rol no válido" }, { status: 400 });
    if (id === g.user.uid && b.role !== cur.role) return NextResponse.json({ error: "No puedes cambiar tu propio rol" }, { status: 400 });
    add("role", b.role);
    changes.push(`rol → ${b.role}`);
  }
  if (typeof b.active === "boolean") {
    if (id === g.user.uid && !b.active) return NextResponse.json({ error: "No puedes desactivarte a ti mismo" }, { status: 400 });
    add("active", b.active);
    changes.push(b.active ? "activado" : "desactivado");
  }
  if (b.siigo_seller_id !== undefined) {
    const s = parseSellerId(b.siigo_seller_id);
    if (s === undefined) return NextResponse.json({ error: "El id de vendedor de Siigo debe ser un número" }, { status: 400 });
    add("siigo_seller_id", s);
    changes.push(`vendedor Siigo → ${s ?? "(usa el del .env)"}`);
  }
  // Bodega de Siigo del usuario (null = usa la de por defecto de Configuración)
  let newWarehouse: number | null | undefined;
  if (b.warehouse_id !== undefined) {
    const w = b.warehouse_id === null || b.warehouse_id === "" ? null : Number(b.warehouse_id);
    if (w !== null && (!Number.isInteger(w) || !(await warehouseExists(w)))) return NextResponse.json({ error: "Bodega no válida" }, { status: 400 });
    newWarehouse = w;
    changes.push(`bodega → ${w ?? "(la de por defecto)"}`);
  }
  if (b.password !== undefined) {
    // Restablecer: el mínimo depende del rol que tendrá el usuario (administrador: 12; cajero y cliente: 8)
    const pwdErr = passwordError(isRole(b.role) ? b.role : cur.role, b.password);
    if (pwdErr || typeof b.password !== "string") return NextResponse.json({ error: pwdErr ?? "Contraseña no válida" }, { status: 400 });
    add("password_hash", await bcrypt.hash(b.password, 10));
    sets.push("failed_attempts = 0", "locked_until = NULL"); // restablecer también desbloquea la cuenta
    changes.push("contraseña restablecida");
  }
  if (!sets.length && newWarehouse === undefined) return NextResponse.json({ error: "Nada que cambiar" }, { status: 400 });

  // Siempre debe quedar al menos un admin activo. La comprobación y el cambio van en una transacción con un
  // candado de Postgres: así dos admins que se desactiven mutuamente a la vez no pueden dejar el sistema sin admin.
  const newRole = (b.role as string | undefined) ?? cur.role;
  const newActive = typeof b.active === "boolean" ? b.active : cur.active;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_LOCK_KEY]);
    const now = (await client.query<{ role: string; active: boolean }>("SELECT role, active FROM users WHERE id = $1", [id])).rows[0];
    if (now.role === "admin" && now.active && (newRole !== "admin" || !newActive)) {
      const others = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND active AND id <> $1", [id]);
      if (others.rows[0].n === 0) {
        await client.query("ROLLBACK");
        return NextResponse.json({ error: "Debe quedar al menos un administrador activo" }, { status: 400 });
      }
    }
    if (sets.length) {
      vals.push(id);
      await client.query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (newWarehouse !== undefined) await assignUserWarehouse(id, newWarehouse, g.user.uid);
  await writeLog("admin", `Usuario ${cur.email} editado: ${changes.join(", ")}`, { userId: g.user.uid, detail: { user_id: id, changes } });
  return NextResponse.json({ ok: true });
}
