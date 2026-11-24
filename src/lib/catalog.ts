// Catálogo vendible de un usuario según su BODEGA de Siigo.
//   - Productos con registro en la bodega del usuario (aunque la cantidad sea 0), más los de WooCommerce si la bodega lo permite
//     (warehouses.include_woo, por defecto sí; el kiosco de un evento puede mostrar solo su bodega).
//   - Sin bodega: solo los de WooCommerce (lo de siempre).
//   - Nunca incluye inactivos. Los servicios y demás tipos no entran porque la sincronización de Siigo no los crea (configurable).
import { query } from "./db";
import { effectiveWarehouse, type EffectiveWarehouse } from "./warehouse";

export type CatalogRow = {
  id: number; sku: string | null; barcode: string | null; name: string; price: number; tax_rate: number;
  prices_include_tax: boolean; image_url: string | null; category: string | null;
};

type Scope = { wid: number | null; includeWoo: boolean };

async function scopeOf(wid: number | null): Promise<Scope> {
  if (wid == null) return { wid: null, includeWoo: true };
  const w = (await query<{ include_woo: boolean }>("SELECT include_woo FROM warehouses WHERE id = $1", [wid])).rows[0];
  return { wid, includeWoo: w?.include_woo ?? true };
}

const FROM = `FROM products p LEFT JOIN product_stock s ON s.product_id = p.id AND s.warehouse_id = $1
   WHERE p.active AND (($2::boolean AND p.origin IN ('woocommerce','ambos')) OR s.product_id IS NOT NULL)`;

/** Versión del catálogo DE ESA BODEGA: cambia si cambia algún producto, la pertenencia a la bodega, la bodega o la opción de Woo. */
export async function catalogVersion(sc: Scope): Promise<string> {
  const { rows } = await query<{ v: string }>(
    `SELECT coalesce(max(p.updated_at)::text, '') || ':' || count(*) || ':w' || coalesce($1::int, 0) || ':' || $2::text AS v ${FROM}`,
    [sc.wid, sc.includeWoo]
  );
  return rows[0].v;
}

export async function loadCatalog(userId: number, role: string, opts: { forKiosk: boolean }) {
  const eff: EffectiveWarehouse = await effectiveWarehouse(userId, role);
  const sc = await scopeOf(eff?.id ?? null);
  const version = await catalogVersion(sc); // antes de leer los productos: si algo cambia en medio, la próxima comparación lo detecta
  const { rows } = await query<CatalogRow>(
    `SELECT p.id, p.sku, p.barcode, p.name, p.price::float8 AS price, p.tax_rate, p.prices_include_tax, p.image_url, p.category
       ${FROM} ${opts.forKiosk ? "AND p.sku IS NOT NULL AND p.sku <> ''" : ""} ORDER BY p.name`,
    [sc.wid, sc.includeWoo]
  );
  return { products: rows, version, warehouse: eff ? { id: eff.id, name: eff.name } : null };
}

/** ¿Estos productos están en el catálogo de la bodega del usuario? (el kiosco no debe vender lo que su catálogo no muestra) */
export async function productsInCatalog(userId: number, role: string, ids: number[]): Promise<Set<number>> {
  const eff = await effectiveWarehouse(userId, role);
  const sc = await scopeOf(eff?.id ?? null);
  const { rows } = await query<{ id: number }>(`SELECT p.id ${FROM} AND p.id = ANY($3::int[])`, [sc.wid, sc.includeWoo, ids]);
  return new Set(rows.map((r) => r.id));
}

/** Versión del catálogo que ve ESTE usuario (la caja la compara con la que tiene guardada). */
export async function userCatalogVersion(userId: number, role: string): Promise<string> {
  const eff = await effectiveWarehouse(userId, role);
  return catalogVersion(await scopeOf(eff?.id ?? null));
}
