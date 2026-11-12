import { query } from "./db";

/**
 * "Versión" del catálogo: cambia si se crea, modifica o desactiva cualquier producto.
 * Cada caja la compara con la que tiene guardada para saber si debe volver a descargar el catálogo
 * (así una caja se entera de los cambios que sincronizó otra caja).
 */
export async function getCatalogVersion(): Promise<string> {
  const { rows } = await query<{ v: string }>(
    "SELECT coalesce(max(updated_at)::text, '') || ':' || count(*) FILTER (WHERE active) AS v FROM products"
  );
  return rows[0].v;
}
