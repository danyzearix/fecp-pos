// UN SOLO candado para TODA sincronización de productos (WooCommerce completa/incremental y Siigo completa/existencias):
// así nunca corren dos a la vez ni chocan sobre los mismos registros. Advisory lock de Postgres: si el servidor se cae, la conexión
// se cierra y el candado se libera solo.
import { pool } from "./db";

export const PRODUCT_SYNC_LOCK_KEY = 727001; // número cualquiera, único para "sincronizar productos"

export async function withSyncLock<T>(fn: () => Promise<T>): Promise<T | { status: "busy" }> {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [PRODUCT_SYNC_LOCK_KEY]);
    if (!rows[0].ok) return { status: "busy" };
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [PRODUCT_SYNC_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
