// Sincronización de PRODUCTOS de Siigo → tabla products (todas las bodegas) + existencias por bodega (product_stock).
// SOLO LEE (GET /v1/products y GET /v1/warehouses). Reglas:
//  - Llave de unión: código de Siigo = SKU de WooCommerce, sin espacios y en MAYÚSCULAS. Códigos repetidos o ambiguos NO se unen: se reportan.
//  - Producto en ambos (origin 'ambos'): solo se agregan siigo_* y existencias. Nombre, imagen, categoría, precio e IVA de Woo NO se tocan.
//  - Solo en Siigo (origin 'siigo'): nombre, código, precio (lista configurada), IVA y categoría (grupo de inventario) salen de Siigo.
//  - Fuera del catálogo vendible: inactivos y tipos distintos de los configurados (por defecto solo "Product"; no servicios).
//  - Un solo candado para todas las sincronizaciones de productos (Woo y Siigo): src/lib/sync-lock.ts.
//  - Ritmo: máximo SIIGO_PRODUCT_SYNC_PER_MINUTE peticiones por minuto, cede el paso a la facturación y reintenta con espera.
import type { PoolClient } from "pg";
import { SIIGO_PRODUCT_SYNC_PER_MINUTE, SIIGO_PRODUCT_SYNC_YIELD_ABOVE } from "@/config/siigo-map";
import { pool, query } from "../db";
import { writeLog } from "../log";
import { getSetting, setSetting } from "../settings";
import { testHooksEnabled } from "../test-hooks";
import { listWarehouses, normCode, SETTING_SIIGO_INCLUDE_TYPES, SETTING_SIIGO_PRICE_LIST } from "../warehouse";
import { PRODUCT_SYNC_LOCK_KEY } from "../sync-lock";
import { siigo, siigoRequestsLastMinute } from "./client";

export const SETTING_LAST_SIIGO_PRODUCT_SYNC = "siigo_products_last_sync";
export const DEFAULT_PRICE_LIST = "Precio de venta 2"; // en los 703 productos de Woo coincide con esta lista (97 %); ver README §11g
export const FALLBACK_PRICE_LIST = "Precio de venta 1";

const tune = (name: string, def: number) => {
  if (!testHooksEnabled()) return def;
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const perMinute = () => tune("PRODUCT_SYNC_PER_MINUTE", SIIGO_PRODUCT_SYNC_PER_MINUTE);
const retryMs = () => tune("PRODUCT_SYNC_RETRY_MS", 5_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SiigoProduct = {
  id: string;
  code?: string;
  name?: string;
  type?: string;
  active?: boolean;
  account_group?: { id?: number; name?: string } | null;
  tax_classification?: "Taxed" | "Exempt" | "Excluded";
  tax_included?: boolean;
  taxes?: { id: number; type: string; percentage: number }[];
  additional_fields?: { barcode?: string };
  warehouses?: { id: number; name?: string; quantity?: number }[];
  prices?: { currency_code?: string; price_list?: { position?: number; name?: string; value?: number }[] }[];
};
type Page = { pagination?: { total_results?: number; page_size?: number }; results?: SiigoProduct[] };

/** Precio según la lista configurada (por NOMBRE: el orden de las listas cambia de un producto a otro); si no está, "Precio de venta 1"; si no, la primera con valor. */
export function pickPrice(p: SiigoProduct, listName: string): { price: number; list: string } | null {
  const lists = p.prices?.find((x) => !x.currency_code || x.currency_code === "COP")?.price_list ?? p.prices?.[0]?.price_list ?? [];
  const by = (n: string) => lists.find((l) => (l.name ?? "").trim().toLowerCase() === n.trim().toLowerCase() && Number(l.value) > 0);
  const hit = by(listName) ?? by(FALLBACK_PRICE_LIST) ?? lists.find((l) => Number(l.value) > 0);
  return hit ? { price: Number(hit.value), list: hit.name ?? "" } : null;
}

/** Siigo → (tarifa efectiva, clase). null si la tarifa no es 0/5/19. */
export function taxOf(p: SiigoProduct): { rate: number; cls: "Taxed" | "Exempt" | "Excluded" } | null {
  const cls = p.tax_classification ?? "Taxed";
  if (cls === "Exempt" || cls === "Excluded") return { rate: 0, cls };
  const iva = (p.taxes ?? []).find((t) => t.type === "IVA");
  const rate = iva ? Number(iva.percentage) : 0;
  return [0, 5, 19].includes(rate) ? { rate, cls: "Taxed" } : null;
}

export type SyncSummary = {
  kind: "completa" | "existencias";
  total_siigo: number;
  creados: number;
  actualizados: number;
  unidos: number; // productos que ya existían en WooCommerce y quedaron unidos por el código
  omitidos_inactivos: number;
  omitidos_tipo: number; // servicios y otros tipos (configurable)
  omitidos_sin_precio: number;
  omitidos_tarifa: number;
  ambiguos: number;
  ambiguos_detalle: string[];
  errores: number;
  errores_detalle: string[];
  desactivados: number;
  bodegas: number;
  existencias_filas: number;
  paginas: number;
  peticiones: number;
  iva_distinto: number; // unidos cuyo IVA en Woo y en Siigo difiere (no se cambia)
  precio_distinto: number; // unidos cuyo precio en Woo y en Siigo difiere (no se cambia)
  unidos_inactivos_en_siigo: number;
  lista_de_precios: string;
};

export type RunRow = {
  id: number; kind: string; trigger: string; status: "running" | "done" | "error"; started_at: Date; finished_at: Date | null;
  progress: { page?: number; pages?: number; products?: number } | null; summary: SyncSummary | null; error: string | null; started_by: number | null;
};

const emptySummary = (kind: SyncSummary["kind"], list: string): SyncSummary => ({
  kind, total_siigo: 0, creados: 0, actualizados: 0, unidos: 0, omitidos_inactivos: 0, omitidos_tipo: 0, omitidos_sin_precio: 0, omitidos_tarifa: 0,
  ambiguos: 0, ambiguos_detalle: [], errores: 0, errores_detalle: [], desactivados: 0, bodegas: 0, existencias_filas: 0, paginas: 0, peticiones: 0,
  iva_distinto: 0, precio_distinto: 0, unidos_inactivos_en_siigo: 0, lista_de_precios: list,
});

// ---------------------------------------------------------------------------------------------------------------------
// Descarga paginada
// ---------------------------------------------------------------------------------------------------------------------
async function fetchAllProducts(runId: number, sum: SyncSummary): Promise<{ products: SiigoProduct[]; complete: boolean }> {
  const gap = Math.ceil(60_000 / perMinute());
  const all: SiigoProduct[] = [];
  let last = 0;
  let total = 0;
  let complete = true;
  for (let page = 1; ; page++) {
    // ritmo propio + prioridad baja: si ya van muchas peticiones en el último minuto (facturación), espera
    for (let w = 0; siigoRequestsLastMinute() > SIIGO_PRODUCT_SYNC_YIELD_ABOVE && w < 30; w++) await sleep(2_000);
    const wait = gap - (Date.now() - last);
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let r: Page | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        sum.peticiones++;
        r = await siigo<Page>("GET", `/v1/products?page=${page}&page_size=100`);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === 3) {
          sum.errores++;
          sum.errores_detalle.push(`página ${page}: ${msg.slice(0, 120)}`);
          complete = false;
          break;
        }
        await sleep(retryMs() * (attempt + 1)); // espera creciente
      }
    }
    if (!r) break; // sin esta página no se puede seguir en orden: la corrida queda incompleta
    all.push(...(r.results ?? []));
    total = r.pagination?.total_results ?? total;
    sum.paginas = page;
    const pages = Math.max(1, Math.ceil(total / 100));
    await query(
      "UPDATE product_sync_runs SET progress = $2::jsonb, heartbeat_at = now() WHERE id = $1",
      [runId, JSON.stringify({ page, pages, products: all.length, total })]
    );
    if (!r.results?.length || page * 100 >= total) break;
  }
  if (complete && total && all.length < total) complete = false; // Siigo informó más productos de los recibidos
  return { products: all, complete };
}

// ---------------------------------------------------------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------------------------------------------------------
type DbProd = { id: number; woo_id: string | null; sku: string | null; siigo_id: string | null; origin: string };

async function writeProducts(client: PoolClient, products: SiigoProduct[], sum: SyncSummary, runStart: Date, complete: boolean, listName: string, types: Set<string>) {
  const db = (await client.query<DbProd>("SELECT id, woo_id::text AS woo_id, sku, siigo_id, origin FROM products")).rows;
  const bySiigoId = new Map<string, DbProd>();
  const wooByNorm = new Map<string, DbProd[]>();
  const siigoOnlyByNorm = new Map<string, DbProd[]>();
  for (const p of db) {
    if (p.siigo_id) bySiigoId.set(p.siigo_id, p);
    const k = normCode(p.sku);
    if (!k) continue;
    const map = p.woo_id ? wooByNorm : siigoOnlyByNorm;
    map.set(k, [...(map.get(k) ?? []), p]);
  }
  // códigos repetidos DENTRO de Siigo (tras normalizar)
  const siigoByNorm = new Map<string, SiigoProduct[]>();
  for (const p of products) {
    const k = normCode(p.code);
    if (k) siigoByNorm.set(k, [...(siigoByNorm.get(k) ?? []), p]);
  }
  const seenSiigoIds: string[] = [];
  const idByCode = new Map<string, number>();

  for (const sp of products) {
    const k = normCode(sp.code);
    try {
      if (!sp.id || !k) {
        sum.errores++;
        if (sum.errores_detalle.length < 20) sum.errores_detalle.push(`producto sin ${!sp.id ? "id" : "código"} (${(sp.name ?? "").slice(0, 40)})`);
        continue;
      }
      if ((siigoByNorm.get(k)?.length ?? 0) > 1) {
        sum.ambiguos++;
        if (sum.ambiguos_detalle.length < 50) sum.ambiguos_detalle.push(`${sp.code}: código repetido en Siigo (${siigoByNorm.get(k)!.length} productos)`);
        continue;
      }
      seenSiigoIds.push(sp.id);
      const woo = wooByNorm.get(k) ?? [];
      const tax = taxOf(sp);
      const pr = pickPrice(sp, listName);
      const group = sp.account_group?.name?.trim() || null;
      const common = [sp.id, sp.code!.trim(), sp.type ?? null, sp.active !== false, group, (sp.name ?? "").trim() || null, pr?.price ?? null, sp.tax_included === true];

      if (woo.length > 1) {
        // Código repetido en WooCommerce: no se une; se marca y se reporta
        sum.ambiguos++;
        if (sum.ambiguos_detalle.length < 50) sum.ambiguos_detalle.push(`${sp.code}: el SKU está repetido en WooCommerce (${woo.length} productos)`);
        await client.query("UPDATE products SET siigo_ambiguous = $2 WHERE id = ANY($1::int[])", [woo.map((w) => w.id), `Código repetido: ${woo.length} productos de WooCommerce con el mismo SKU. No se unió con Siigo.`]);
        continue;
      }

      if (woo.length === 1) {
        // ---- UNIDO con WooCommerce: solo siigo_*; nada de lo de Woo se pisa ----
        const w = woo[0];
        const cur = (
          await client.query<{ price: number; woo_tax_rate: number | null; tax_rate: number; siigo_tax_class: string | null }>(
            "SELECT price::float8 AS price, woo_tax_rate, tax_rate, siigo_tax_class FROM products WHERE id = $1",
            [w.id]
          )
        ).rows[0];
        const upd = await client.query(
          `UPDATE products SET siigo_id = $2, siigo_code = $3, siigo_type = $4, siigo_active = $5, siigo_group = $6, siigo_name = $7,
                 siigo_price = $8, siigo_price_includes_tax = $9, siigo_synced_at = now(), siigo_ambiguous = NULL, origin = 'ambos',
                 updated_at = CASE WHEN (siigo_id, siigo_code, origin) IS DISTINCT FROM ($2::text, $3::text, 'ambos') THEN now() ELSE updated_at END
           WHERE id = $1 AND (siigo_id IS NULL OR siigo_id = $2)`,
          [w.id, ...common]
        );
        if (!upd.rowCount) {
          sum.ambiguos++;
          if (sum.ambiguos_detalle.length < 50) sum.ambiguos_detalle.push(`${sp.code}: el producto de WooCommerce ya está unido a otro producto de Siigo`);
          continue;
        }
        sum.unidos++;
        if (sp.active === false) sum.unidos_inactivos_en_siigo++;
        if (tax && cur.woo_tax_rate !== null && cur.woo_tax_rate !== tax.rate) sum.iva_distinto++;
        if (pr && Math.abs(cur.price - pr.price) > 0.5) sum.precio_distinto++;
        idByCode.set(sp.id, w.id);
        continue;
      }

      // ---- Solo en Siigo ----
      const existing = bySiigoId.get(sp.id) ?? (siigoOnlyByNorm.get(k) ?? []).find((x) => !x.siigo_id || x.siigo_id === sp.id);
      const vendibleType = types.has(sp.type ?? "");
      if (sp.active === false || !vendibleType) {
        if (sp.active === false) sum.omitidos_inactivos++;
        else sum.omitidos_tipo++;
        if (existing && existing.origin === "siigo") {
          await client.query("UPDATE products SET active = FALSE, siigo_active = $2, siigo_type = $3, siigo_synced_at = now(), updated_at = now() WHERE id = $1 AND active", [existing.id, sp.active !== false, sp.type ?? null]);
          idByCode.set(sp.id, existing.id);
        }
        continue;
      }
      if (!tax) {
        sum.omitidos_tarifa++;
        continue;
      }
      if (!pr) {
        sum.omitidos_sin_precio++;
        continue;
      }
      const barcode = sp.additional_fields?.barcode?.trim() || sp.code!.trim();
      if (existing) {
        await client.query(
          `UPDATE products SET sku = $2, barcode = $3, name = $4, price = $5, tax_rate = $6, woo_tax_rate = NULL, prices_include_tax = $7, category = $8, active = TRUE,
                 siigo_id = $9, siigo_code = $10, siigo_type = $11, siigo_active = $12, siigo_group = $13, siigo_name = $14, siigo_price = $15, siigo_price_includes_tax = $16,
                 siigo_tax_class = $17, siigo_checked_at = now(), siigo_synced_at = now(), siigo_ambiguous = NULL, origin = 'siigo',
                 updated_at = CASE WHEN (sku, barcode, name, price, tax_rate, prices_include_tax, category, active) IS DISTINCT FROM ($2::text, $3::text, $4::text, $5::numeric, $6::int, $7::boolean, $8::text, TRUE) THEN now() ELSE updated_at END
           WHERE id = $1`,
          [existing.id, sp.code!.trim(), barcode, (sp.name ?? "").trim(), pr.price, tax.rate, sp.tax_included === true, group, ...common, tax.cls]
        );
        sum.actualizados++;
        idByCode.set(sp.id, existing.id);
      } else {
        const ins = await client.query<{ id: number }>(
          `INSERT INTO products (woo_id, sku, barcode, name, price, tax_rate, woo_tax_rate, prices_include_tax, image_url, category, active, updated_at, origin,
                                 siigo_id, siigo_code, siigo_type, siigo_active, siigo_group, siigo_name, siigo_price, siigo_price_includes_tax, siigo_tax_class, siigo_checked_at, siigo_synced_at)
           VALUES (NULL,$1,$2,$3,$4,$5,NULL,$6,NULL,$7,TRUE,now(),'siigo',$8,$9,$10,$11,$12,$13,$14,$15,$16,now(),now()) RETURNING id`,
          [sp.code!.trim(), barcode, (sp.name ?? "").trim(), pr.price, tax.rate, sp.tax_included === true, group, ...common, tax.cls]
        );
        sum.creados++;
        idByCode.set(sp.id, ins.rows[0].id);
      }
    } catch (e) {
      sum.errores++;
      if (sum.errores_detalle.length < 20) sum.errores_detalle.push(`${String(sp.code).slice(0, 30)}: ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`);
    }
  }

  // Lo que Siigo ya no tiene (solo si se leyó TODO el catálogo): los solo-Siigo se desactivan; los unidos vuelven a ser solo de Woo
  if (complete && seenSiigoIds.length > 0) {
    const gone = await client.query(
      `UPDATE products SET active = FALSE, siigo_active = FALSE, updated_at = now()
        WHERE origin = 'siigo' AND active AND NOT (siigo_id = ANY($1::text[]))`,
      [seenSiigoIds]
    );
    sum.desactivados += gone.rowCount ?? 0;
    await client.query(
      `UPDATE products SET origin = 'woocommerce', siigo_id = NULL, siigo_code = NULL, siigo_type = NULL, siigo_active = NULL, siigo_group = NULL, siigo_name = NULL,
              siigo_price = NULL, siigo_price_includes_tax = NULL, siigo_ambiguous = NULL, updated_at = now()
        WHERE origin = 'ambos' AND NOT (siigo_id = ANY($1::text[]))`,
      [seenSiigoIds]
    );
  }
  void runStart;
  return idByCode;
}

async function writeStock(client: PoolClient, products: SiigoProduct[], idBySiigo: Map<string, number>, sum: SyncSummary) {
  const rows: { p: number; w: number; q: number }[] = [];
  const whNames = new Map<number, string>();
  for (const sp of products) {
    const pid = idBySiigo.get(sp.id);
    if (!pid) continue;
    for (const w of sp.warehouses ?? []) {
      if (!Number.isInteger(w.id)) continue;
      rows.push({ p: pid, w: w.id, q: Number(w.quantity) || 0 });
      if (w.name) whNames.set(w.id, w.name);
    }
  }
  // bodegas con existencias que no están en la lista (p. ej. «Sin asignar» = -1)
  for (const [id, name] of whNames) {
    await client.query("INSERT INTO warehouses (id, name, active) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING", [id, name, id > 0]);
  }
  const ids = [...new Set(rows.map((r) => r.p))];
  const touched = [...new Set([...idBySiigo.values()])];
  // reemplazo completo de las existencias de los productos de esta lectura
  await client.query("DELETE FROM product_stock WHERE product_id = ANY($1::int[])", [touched]);
  for (let i = 0; i < rows.length; i += 4000) {
    const part = rows.slice(i, i + 4000);
    await client.query(
      `INSERT INTO product_stock (product_id, warehouse_id, quantity, updated_at)
       SELECT * FROM unnest($1::int[], $2::int[], $3::numeric[], $4::timestamptz[])
       ON CONFLICT (product_id, warehouse_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = EXCLUDED.updated_at`,
      [part.map((r) => r.p), part.map((r) => r.w), part.map((r) => r.q), part.map(() => new Date())]
    );
  }
  sum.existencias_filas = rows.length;
  sum.bodegas = new Set(rows.map((r) => r.w)).size;
  void ids;
}

async function runSync(runId: number, kind: "completa" | "existencias", userId: number | null) {
  const listName = (await getSetting(SETTING_SIIGO_PRICE_LIST)) || DEFAULT_PRICE_LIST;
  const types = new Set(((await getSetting(SETTING_SIIGO_INCLUDE_TYPES)) || "Product").split(",").map((s) => s.trim()).filter(Boolean));
  const sum = emptySummary(kind, listName);
  const runStart = new Date();
  try {
    await listWarehouses({ refresh: true }).catch(() => {});
    const { products, complete } = await fetchAllProducts(runId, sum);
    sum.total_siigo = products.length;
    if (!products.length) throw new Error(sum.errores_detalle[0] ?? "Siigo no devolvió productos");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      let idBySiigo: Map<string, number>;
      if (kind === "completa") {
        idBySiigo = await writeProducts(client, products, sum, runStart, complete, listName, types);
      } else {
        idBySiigo = new Map();
        const have = (await client.query<{ id: number; siigo_id: string }>("SELECT id, siigo_id FROM products WHERE siigo_id IS NOT NULL")).rows;
        for (const h of have) idBySiigo.set(h.siigo_id, h.id);
      }
      await writeStock(client, products, idBySiigo, sum);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    if (kind === "completa") await setSetting(SETTING_LAST_SIIGO_PRODUCT_SYNC, runStart.toISOString());
    await query("UPDATE product_sync_runs SET status = 'done', finished_at = now(), summary = $2::jsonb, heartbeat_at = now() WHERE id = $1", [runId, JSON.stringify(sum)]);
    const warn = sum.ambiguos > 0 || sum.errores > 0 || !complete;
    await writeLog("sync", `Sync Siigo ${kind}: ${sum.creados} creados, ${sum.actualizados} actualizados, ${sum.unidos} unidos con Woo, ${sum.ambiguos} ambiguos, ${sum.errores} con error, ${sum.existencias_filas} existencias${complete ? "" : " (INCOMPLETA)"}`, {
      level: warn ? "warn" : "info",
      userId: userId ?? undefined,
      detail: { ...sum, completa: complete },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await query("UPDATE product_sync_runs SET status = 'error', finished_at = now(), error = $2, summary = $3::jsonb WHERE id = $1", [runId, msg.slice(0, 500), JSON.stringify(sum)]);
    await writeLog("sync", `Sync Siigo ${kind} falló: ${msg}`, { level: "error", userId: userId ?? undefined, detail: { error: msg, ...sum } });
  }
}

export type StartResult = { ok: true; runId: number } | { ok: false; status: number; error: string };

/**
 * Inicia la sincronización y responde enseguida (corre en segundo plano). Candado compartido con WooCommerce: si hay otra en curso → 409.
 * El candado (advisory lock) se toma ANTES de responder y lo guarda la conexión de la corrida hasta que termina.
 */
export async function startProductSync(opts: { kind: "completa" | "existencias"; trigger: "manual" | "automatica"; userId: number | null }): Promise<StartResult> {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [PRODUCT_SYNC_LOCK_KEY]);
    locked = rows[0].ok;
    if (!locked) {
      client.release();
      return { ok: false, status: 409, error: "Ya hay una sincronización de productos en curso (WooCommerce o Siigo). Espere a que termine." };
    }
    // corridas que quedaron «running» por una caída: el candado se soltó solo, así que ya no están corriendo
    await client.query("UPDATE product_sync_runs SET status = 'error', finished_at = now(), error = 'Interrumpida (el servidor se reinició)' WHERE status = 'running'");
    const ins = await client.query<{ id: number }>(
      "INSERT INTO product_sync_runs (kind, trigger, started_by) VALUES ($1,$2,$3) RETURNING id",
      [opts.kind, opts.trigger, opts.userId]
    );
    const runId = ins.rows[0].id;
    void runSync(runId, opts.kind, opts.userId)
      .catch(() => {})
      .finally(async () => {
        await client.query("SELECT pg_advisory_unlock($1)", [PRODUCT_SYNC_LOCK_KEY]).catch(() => {});
        client.release();
      });
    return { ok: true, runId };
  } catch (e) {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [PRODUCT_SYNC_LOCK_KEY]).catch(() => {});
    client.release();
    throw e;
  }
}

export type ProductSyncStatus = {
  running: RunRow | null;
  last: RunRow | null;
  lastFull: RunRow | null;
  lastStock: RunRow | null;
  counts: { total: number; woocommerce: number; siigo: number; ambos: number; ambiguos: number; con_existencias: number };
};

const COLS = "id, kind, trigger, status, started_at, finished_at, progress, summary, error, started_by";

export async function getProductSyncStatus(): Promise<ProductSyncStatus> {
  const one = async (where: string) => (await query<RunRow>(`SELECT ${COLS} FROM product_sync_runs WHERE ${where} ORDER BY id DESC LIMIT 1`)).rows[0] ?? null;
  const counts = (
    await query<ProductSyncStatus["counts"]>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE origin = 'woocommerce')::int AS woocommerce, count(*) FILTER (WHERE origin = 'siigo')::int AS siigo,
              count(*) FILTER (WHERE origin = 'ambos')::int AS ambos, count(*) FILTER (WHERE siigo_ambiguous IS NOT NULL)::int AS ambiguos,
              (SELECT count(DISTINCT product_id)::int FROM product_stock) AS con_existencias
         FROM products`
    )
  ).rows[0];
  return { running: await one("status = 'running'"), last: await one("TRUE"), lastFull: await one("kind = 'completa' AND status = 'done'"), lastStock: await one("kind = 'existencias' AND status = 'done'"), counts };
}
