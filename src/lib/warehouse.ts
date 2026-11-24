// BODEGAS de Siigo: lista (en vivo con caché corta y copia en la base), bodega de cada usuario, cambio de sesión del admin y
// validación de la bodega con la que llega una venta. La bodega la decide el SERVIDOR; el navegador solo la informa.
import { query } from "./db";
import { writeLog } from "./log";
import { getSetting, setSetting } from "./settings";
import { siigo } from "./siigo/client";

export const SETTING_DEFAULT_WAREHOUSE = "default_warehouse_id";
export const SETTING_STOCK_SYNC_MINUTES = "siigo_stock_sync_minutes"; // 0 = apagada
export const SETTING_SIIGO_PRICE_LIST = "siigo_price_list"; // nombre de la lista de precios de Siigo (p. ej. "Precio de venta 2")
export const SETTING_SIIGO_INCLUDE_TYPES = "siigo_include_types"; // tipos de Siigo que entran al catálogo vendible ("Product" por defecto)

export type Warehouse = { id: number; name: string; active: boolean; include_woo: boolean };
export type WarehouseList = { warehouses: Warehouse[]; stale: boolean; error?: string; fetchedAt: number };

const CACHE_MS = 5 * 60_000;
const g = globalThis as unknown as { __whCache?: { at: number; list: Warehouse[] } };

/** Código normalizado: sin espacios y en MAYÚSCULAS. Es la llave de unión entre Siigo y WooCommerce. */
export const normCode = (s: unknown) => String(s ?? "").replace(/\s+/g, "").toUpperCase();

export async function storedWarehouses(): Promise<Warehouse[]> {
  const { rows } = await query<Warehouse>("SELECT id, name, active, include_woo FROM warehouses WHERE id > 0 ORDER BY active DESC, id");
  return rows;
}

/**
 * Lista de bodegas. Consulta a Siigo (GET /v1/warehouses) con caché de 5 minutos; `refresh` la ignora. Si Siigo no responde se usa la
 * última lista guardada en la base y se avisa (stale = true). Guarda la lista conservando include_woo de cada bodega.
 */
export async function listWarehouses(opts: { refresh?: boolean } = {}): Promise<WarehouseList> {
  const now = Date.now();
  if (!opts.refresh && g.__whCache && now - g.__whCache.at < CACHE_MS) {
    return { warehouses: await storedWarehouses(), stale: false, fetchedAt: g.__whCache.at };
  }
  try {
    const raw = await siigo<unknown>("GET", "/v1/warehouses");
    const arr = Array.isArray(raw) ? raw : ((raw as { results?: unknown[] })?.results ?? []);
    const list = arr
      .map((x) => x as { id?: number; name?: string; active?: boolean })
      .filter((x) => Number.isInteger(x.id) && typeof x.name === "string")
      .map((x) => ({ id: x.id as number, name: (x.name as string).trim(), active: x.active !== false }));
    for (const w of list) {
      await query(
        `INSERT INTO warehouses (id, name, active, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, active = EXCLUDED.active, updated_at = now()`,
        [w.id, w.name, w.active]
      );
    }
    g.__whCache = { at: now, list: [] };
    return { warehouses: await storedWarehouses(), stale: false, fetchedAt: now };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeLog("sync", `No se pudo consultar las bodegas en Siigo: ${msg}`, { level: "warn", detail: { error: msg } });
    return { warehouses: await storedWarehouses(), stale: true, error: msg, fetchedAt: 0 };
  }
}

export async function getDefaultWarehouseId(): Promise<number | null> {
  const v = Number(await getSetting(SETTING_DEFAULT_WAREHOUSE));
  return Number.isInteger(v) && v > 0 ? v : null;
}

const nameOf = async (id: number | null): Promise<string | null> =>
  id == null ? null : ((await query<{ name: string }>("SELECT name FROM warehouses WHERE id = $1", [id])).rows[0]?.name ?? `Bodega ${id}`);

export type EffectiveWarehouse = { id: number; name: string; source: "sesion" | "asignada" | "defecto" } | null;

/**
 * Bodega con la que vende un usuario: admin → la de su sesión (si la cambió), luego la suya, luego la de por defecto;
 * cajero y cliente (kiosco) → la suya, luego la de por defecto. null = sin bodega (no se manda bodega a Siigo).
 */
export async function effectiveWarehouse(userId: number, role: string): Promise<EffectiveWarehouse> {
  const u = (await query<{ warehouse_id: number | null; session_warehouse_id: number | null }>("SELECT warehouse_id, session_warehouse_id FROM users WHERE id = $1", [userId])).rows[0];
  if (!u) return null;
  let id: number | null = null;
  let source: "sesion" | "asignada" | "defecto" = "defecto";
  if (role === "admin" && u.session_warehouse_id) {
    id = u.session_warehouse_id;
    source = "sesion";
  } else if (u.warehouse_id) {
    id = u.warehouse_id;
    source = "asignada";
  } else {
    id = await getDefaultWarehouseId();
  }
  return id == null ? null : { id, name: (await nameOf(id)) ?? `Bodega ${id}`, source };
}

/** Anota en el historial la bodega con la que el usuario puede vender desde ahora (cierra la anterior). */
/** baseline = primera anotación de un usuario: vale "desde siempre" (lo que ya vendía antes del primer cambio queda cubierto). */
async function logEffective(userId: number, role: string, kind: "asignada" | "sesion" | "defecto", by: number | null, baseline = false) {
  const eff = await effectiveWarehouse(userId, role);
  const open = (await query<{ id: number; warehouse_id: number | null }>("SELECT id, warehouse_id FROM user_warehouse_log WHERE user_id = $1 AND valid_to IS NULL ORDER BY id DESC LIMIT 1", [userId])).rows[0];
  if (open && (open.warehouse_id ?? null) === (eff?.id ?? null)) return;
  if (open) await query("UPDATE user_warehouse_log SET valid_to = now() WHERE user_id = $1 AND valid_to IS NULL", [userId]);
  await query("INSERT INTO user_warehouse_log (user_id, warehouse_id, kind, changed_by, valid_from) VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN TIMESTAMPTZ 'epoch' ELSE now() END)", [userId, eff?.id ?? null, kind, by, baseline]);
}

export const warehouseExists = async (id: number) => (await query("SELECT 1 FROM warehouses WHERE id = $1 AND id > 0", [id])).rowCount === 1;

/** Admin → Usuarios: asigna (o quita, id = null) la bodega de un usuario. */
export async function assignUserWarehouse(userId: number, warehouseId: number | null, by: number) {
  const u = (await query<{ role: string; warehouse_id: number | null }>("SELECT role, warehouse_id FROM users WHERE id = $1", [userId])).rows[0];
  if (!u) return;
  await logEffective(userId, u.role, "defecto", by, true); // anota la bodega con la que vendía antes del cambio
  await query("UPDATE users SET warehouse_id = $2 WHERE id = $1", [userId, warehouseId]);
  await logEffective(userId, u.role, "asignada", by);
  if ((u.warehouse_id ?? null) !== warehouseId) {
    await writeLog("admin", `Bodega del usuario ${userId}: ${u.warehouse_id ?? "sin bodega"} → ${warehouseId ?? "sin bodega"}`, { userId: by, detail: { user_id: userId, de: u.warehouse_id, a: warehouseId } });
  }
}

/** El admin cambia la bodega con la que vende en SU sesión de caja (null = volver a la suya). Queda en el log quién y a cuál. */
export async function setSessionWarehouse(adminId: number, warehouseId: number | null) {
  const before = await effectiveWarehouse(adminId, "admin");
  await logEffective(adminId, "admin", "defecto", adminId, true);
  await query("UPDATE users SET session_warehouse_id = $2 WHERE id = $1", [adminId, warehouseId]);
  await logEffective(adminId, "admin", "sesion", adminId);
  const after = await effectiveWarehouse(adminId, "admin");
  await writeLog("admin", `Cambio de bodega de la sesión de caja: ${before?.name ?? "sin bodega"} → ${after?.name ?? "sin bodega"}`, {
    userId: adminId,
    detail: { de: before?.id ?? null, a: after?.id ?? null },
  });
  return after;
}

/** Al iniciar sesión se descarta el cambio de bodega de la sesión anterior (es «para su sesión»). */
export async function clearSessionWarehouse(userId: number, role: string) {
  const r = await query("UPDATE users SET session_warehouse_id = NULL WHERE id = $1 AND session_warehouse_id IS NOT NULL", [userId]);
  if (r.rowCount) await logEffective(userId, role, "sesion", userId);
}

/** Admin → Configuración: bodega por defecto de los usuarios sin asignar. */
export async function setDefaultWarehouse(warehouseId: number | null, by: number) {
  const pre = await query<{ id: number; role: string }>("SELECT id, role FROM users WHERE warehouse_id IS NULL");
  for (const u of pre.rows) await logEffective(u.id, u.role, "defecto", by, true);
  await setSetting(SETTING_DEFAULT_WAREHOUSE, warehouseId == null ? "" : String(warehouseId));
  // los usuarios sin bodega propia cambian de bodega efectiva: se anota para validar ventas sin conexión hechas antes del cambio
  for (const u of pre.rows) await logEffective(u.id, u.role, "defecto", by);
  await writeLog("admin", `Bodega por defecto: ${warehouseId ?? "ninguna"}`, { userId: by, detail: { warehouse_id: warehouseId } });
}

/**
 * Valida la bodega con la que llega una venta (cola sin conexión incluida). Reglas:
 *  - sin bodega en la venta (cliente viejo): se usa la efectiva del usuario;
 *  - igual a la efectiva ahora: OK;
 *  - distinta: solo si era la bodega del usuario cuando se hizo la venta (historial ±5 min); si no, se rechaza.
 */
export async function resolveSaleWarehouse(
  userId: number,
  role: string,
  claimed: unknown,
  atIso: string
): Promise<{ ok: true; id: number | null; name: string | null } | { ok: false; error: string }> {
  const eff = await effectiveWarehouse(userId, role);
  const c = claimed === null || claimed === undefined || claimed === "" ? null : Number(claimed);
  if (c !== null && !Number.isInteger(c)) return { ok: false, error: "Bodega inválida" };
  if (c === null) return { ok: true, id: eff?.id ?? null, name: eff?.name ?? null };
  if (eff && c === eff.id) return { ok: true, id: eff.id, name: eff.name };
  const t = new Date(atIso);
  const ok = await query(
    `SELECT 1 FROM user_warehouse_log
      WHERE user_id = $1 AND warehouse_id = $2 AND valid_from <= $3::timestamptz + interval '5 minutes'
        AND (valid_to IS NULL OR valid_to >= $3::timestamptz - interval '5 minutes') LIMIT 1`,
    [userId, c, isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString()]
  );
  if (ok.rowCount) return { ok: true, id: c, name: await nameOf(c) };
  await writeLog("seguridad", `Venta con una bodega que no corresponde al usuario (bodega ${c}, la suya: ${eff?.id ?? "ninguna"})`, {
    level: "warn", userId, detail: { claimed: c, effective: eff?.id ?? null, role },
  });
  return { ok: false, error: "La bodega de esta venta no corresponde a su usuario. Cierre sesión, vuelva a entrar y repita la venta." };
}

/** Cada cuántos minutos se actualizan las existencias (0 = apagado; 30 por defecto). Configurable en Admin → Configuración. */
export async function stockSyncMinutes(): Promise<number> {
  const raw = await getSetting(SETTING_STOCK_SYNC_MINUTES);
  const n = raw === null ? 30 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}
