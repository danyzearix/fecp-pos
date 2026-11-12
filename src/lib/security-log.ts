import { query } from "./db";
import { writeLog } from "./log";

/** Agrupa rutas con identificadores: /api/sales/<uuid>/retry → /api/sales/:id/retry */
export function normalizePath(path: string): string {
  return path
    .slice(0, 200)
    .replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g, ":id")
    .replace(/\/\d+(?=\/|$)/g, "/:n");
}

/**
 * Registra un acceso bloqueado por permisos (tipo 'seguridad'). Para no saturar el log, se guarda UN registro por
 * usuario + método + ruta + minuto; los intentos repetidos en ese minuto suben el contador `intentos` de ese registro.
 * Nunca lanza error.
 */
export async function logSecurityBlock(i: { userId: number; role: string; method: string; path: string; source: "proxy" | "api" }) {
  const path = normalizePath(i.path);
  const method = i.method.toUpperCase().slice(0, 10);
  try {
    const upd = await query(
      `UPDATE logs SET detail = jsonb_set(detail, '{intentos}', to_jsonb(coalesce((detail->>'intentos')::int, 1) + 1))
        WHERE type = 'seguridad' AND user_id = $1 AND detail->>'path' = $2 AND detail->>'method' = $3
          AND created_at >= date_trunc('minute', now())
        RETURNING id`,
      [i.userId, path, method]
    );
    if (upd.rowCount) return;
    await writeLog("seguridad", `Acceso bloqueado: ${i.role} → ${method} ${path}`, {
      level: "warn",
      userId: i.userId,
      detail: { role: i.role, method, path, source: i.source, intentos: 1 },
    });
  } catch (e) {
    console.error("[seguridad] no se pudo registrar:", e);
  }
}
