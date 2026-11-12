// Autenticación del lado servidor (usa base de datos y bcrypt).
//
// TODO (versión 2): 2FA con TOTP. Plan: agregar columnas totp_secret y totp_enabled
// a users; tras validar la contraseña, si totp_enabled, responder "requiere_2fa" y pedir
// el código de 6 dígitos antes de crear la cookie de sesión.
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { canCallApi, canOpenPage, homeFor, isRole } from "./permissions";
import { query } from "./db";
import { writeLog } from "./log";
import { logSecurityBlock } from "./security-log";
import { SESSION_COOKIE, SESSION_HOURS, SessionPayload, signSession, verifySession } from "./session";

export const MAX_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;

type UserRow = {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  role: string;
  active: boolean;
  failed_attempts: number;
  locked_until: Date | null;
};

export type LoginResult =
  | { ok: true; user: SessionPayload }
  | { ok: false; status: number; error: string };

export async function attemptLogin(emailRaw: string, password: string): Promise<LoginResult> {
  const email = emailRaw.trim().toLowerCase();
  const { rows } = await query<UserRow>("SELECT * FROM users WHERE email = $1", [email]);
  const u = rows[0];

  if (!u || !u.active) {
    await writeLog("login", `Login fallido (usuario inexistente o inactivo): ${email}`, {
      level: "warn",
      detail: { email },
    });
    return { ok: false, status: 401, error: "Correo o contraseña incorrectos" };
  }

  if (u.locked_until && u.locked_until.getTime() > Date.now()) {
    const mins = Math.ceil((u.locked_until.getTime() - Date.now()) / 60000);
    return {
      ok: false,
      status: 423,
      error: `Cuenta bloqueada por intentos fallidos. Intenta de nuevo en ${mins} min.`,
    };
  }

  const good = await bcrypt.compare(password, u.password_hash);
  if (!good) {
    // El bloqueo se aplica en una sola consulta para evitar carreras entre intentos simultáneos.
    const upd = await query<{ failed_attempts: number; locked_until: Date | null }>(
      `UPDATE users SET
         failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
         locked_until    = CASE WHEN failed_attempts + 1 >= $2
                                THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
       WHERE id = $1 RETURNING failed_attempts, locked_until`,
      [u.id, MAX_ATTEMPTS, String(LOCK_MINUTES)]
    );
    const locked = upd.rows[0]?.locked_until && upd.rows[0].locked_until.getTime() > Date.now();
    await writeLog("login", locked ? `Usuario bloqueado: ${email}` : `Contraseña incorrecta: ${email}`, {
      level: "warn",
      userId: u.id,
    });
    return {
      ok: false,
      status: locked ? 423 : 401,
      error: locked
        ? `Demasiados intentos. Cuenta bloqueada ${LOCK_MINUTES} minutos.`
        : "Correo o contraseña incorrectos",
    };
  }

  await query("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1", [u.id]);
  await writeLog("login", `Login correcto: ${email}`, { userId: u.id });
  if (!isRole(u.role)) return { ok: false, status: 403, error: "Rol de usuario no válido" };
  return { ok: true, user: { uid: u.id, name: u.name, role: u.role } };
}

export async function setSessionCookie(p: SessionPayload) {
  const token = await signSession(p);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "true",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** Usuario actual: valida el JWT y confirma en la BD que sigue activo (por si lo desactivaron). */
export async function getCurrentUser(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const s = await verifySession(token);
  if (!s) return null;
  const { rows } = await query<{ active: boolean; role: string; name: string }>(
    "SELECT active, role, name FROM users WHERE id = $1",
    [s.uid]
  );
  if (!rows[0]?.active || !isRole(rows[0].role)) return null;
  return { uid: s.uid, name: rows[0].name, role: rows[0].role };
}

/**
 * Guardia de cada endpoint de la API (segunda capa, después del proxy): valida sesión Y que el rol
 * pueda llamar ESTE método en ESTA ruta según src/lib/permissions.ts.
 * Uso:  const g = await guardApi(req);  if (!g.ok) return g.res;  const user = g.user;
 */
export async function guardApi(req: Request): Promise<{ ok: true; user: SessionPayload } | { ok: false; res: NextResponse }> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, res: NextResponse.json({ error: "No autenticado" }, { status: 401 }) };
  const path = new URL(req.url).pathname;
  if (!canCallApi(user.role, req.method, path)) {
    await logSecurityBlock({ userId: user.uid, role: user.role, method: req.method, path, source: "api" });
    return { ok: false, res: NextResponse.json({ error: "Sin permiso" }, { status: 403 }) };
  }
  return { ok: true, user };
}

/** Guardia de una página (servidor): sin sesión → login; sin permiso → pantalla de inicio de su rol. */
export async function requirePage(path: string): Promise<SessionPayload> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!canOpenPage(user.role, path)) redirect(homeFor(user.role));
  return user;
}

// ---------------------------------------------------------------------------
// Salida del kiosco (rol cliente): un ADMIN escribe su correo y contraseña.
// A propósito NO usa attemptLogin(): así alguien frente al kiosco no puede bloquear la cuenta de un admin
// (cada fallo suma al contador de ESA cuenta). Tiene su propio límite por kiosco y deja todo en logs.
// ---------------------------------------------------------------------------
const KIOSK_EXIT_MAX_FAILS = 5;
const KIOSK_EXIT_WINDOW_MIN = 10;
const DUMMY_HASH = bcrypt.hashSync("kiosco-sin-usuario", 10); // para que el tiempo de respuesta no revele si el correo existe

export async function authorizeKioskExit(
  kioskUserId: number,
  emailRaw: string,
  password: string
): Promise<{ ok: true; adminName: string } | { ok: false; status: number; error: string }> {
  const email = emailRaw.trim().toLowerCase().slice(0, 150);

  const fails = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM logs
      WHERE type = 'seguridad' AND user_id = $1 AND message LIKE 'Salida del kiosco: intento fallido%'
        AND created_at > now() - ($2 || ' minutes')::interval`,
    [kioskUserId, String(KIOSK_EXIT_WINDOW_MIN)]
  );
  if (fails.rows[0].n >= KIOSK_EXIT_MAX_FAILS) {
    await writeLog("seguridad", "Salida del kiosco: bloqueada por demasiados intentos", { level: "error", userId: kioskUserId });
    return { ok: false, status: 429, error: `Demasiados intentos. Espere ${KIOSK_EXIT_WINDOW_MIN} minutos.` };
  }

  const { rows } = await query<{ id: number; name: string; password_hash: string; role: string; active: boolean }>(
    "SELECT id, name, password_hash, role, active FROM users WHERE email = $1",
    [email]
  );
  const u = rows[0];
  const passwordOk = await bcrypt.compare(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !passwordOk || !u.active || u.role !== "admin") {
    await writeLog("seguridad", "Salida del kiosco: intento fallido", {
      level: "warn",
      userId: kioskUserId,
      detail: { email_intentado: email, motivo: !u ? "correo desconocido" : !passwordOk ? "contraseña incorrecta" : "no es un administrador activo" },
    });
    return { ok: false, status: 401, error: "Correo o contraseña incorrectos, o no es administrador" };
  }
  await writeLog("seguridad", `Salida del kiosco autorizada por ${u.name}`, { userId: kioskUserId, detail: { admin_id: u.id } });
  return { ok: true, adminName: u.name };
}
