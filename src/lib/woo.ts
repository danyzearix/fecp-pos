// Cliente WooCommerce + sincronización de productos (completa e incremental) a la tabla products.
import { pool, query } from "./db";
import { writeLog } from "./log";
import { getSetting, setSetting, SETTING_LAST_SYNC, SETTING_PRICES_INCLUDE_TAX } from "./settings";
import { withSyncLock } from "./sync-lock";
import { syncSiigoTaxClassesAll, syncSiigoTaxClassesFor, type SiigoTaxSyncResult } from "./siigo/products";

/** Clasificación de IVA desde Siigo. Si Siigo falla, la sincronización de Woo NO falla: se avisa en logs. */
async function siigoTaxStep(run: () => Promise<SiigoTaxSyncResult>, userId?: number) {
  try {
    const r = await run();
    if (r.notFound.length || r.oddRates.length) {
      await writeLog("sync", `Siigo: ${r.notFound.length} productos no existen en Siigo, ${r.oddRates.length} con tarifa no soportada`, {
        level: "warn",
        userId,
        detail: { noExistenEnSiigo: r.notFound.slice(0, 100), tarifaNoSoportada: r.oddRates },
      });
    }
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeLog("sync", `No se pudo consultar el IVA de los productos en Siigo: ${msg}`, { level: "error", userId, detail: { error: msg } });
    return null;
  }
}
import {
  BARCODE_META_KEYS,
  DEFAULT_TAX_RATE,
  TAX_CLASS_RATES,
  TAX_STATUS_EXEMPT,
  type TaxRate,
} from "@/config/tax-map";

type WooMeta = { key: string; value: unknown };
type WooImage = { src?: string };
type WooProduct = {
  id: number;
  name: string;
  type: string; // simple | variable | grouped | external
  status: string;
  sku?: string;
  price?: string;
  regular_price?: string;
  tax_status?: string;
  tax_class?: string;
  global_unique_id?: string;
  images?: WooImage[];
  categories?: { name: string }[];
  meta_data?: WooMeta[];
  variations?: number[];
};
type WooVariation = {
  id: number;
  status?: string;
  sku?: string;
  price?: string;
  regular_price?: string;
  tax_status?: string;
  tax_class?: string; // 'parent' = hereda del padre
  global_unique_id?: string;
  image?: WooImage | null;
  attributes?: { name: string; option: string }[];
  meta_data?: WooMeta[];
};

const TIMEOUT_MS = 30_000;

function baseUrl() {
  const u = process.env.WOO_URL;
  if (!u) throw new Error("Falta WOO_URL en .env.local");
  return u.replace(/\/+$/, "");
}

/** GET a la API de Woo. Devuelve los datos y el total de páginas (cabecera X-WP-TotalPages). */
export async function wooGet<T>(path: string, params: Record<string, string | number> = {}) {
  const key = process.env.WOO_CONSUMER_KEY;
  const secret = process.env.WOO_CONSUMER_SECRET;
  if (!key || !secret) throw new Error("Faltan WOO_CONSUMER_KEY / WOO_CONSUMER_SECRET");

  const base = baseUrl();
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const headers: Record<string, string> = { Accept: "application/json" };
  if (base.startsWith("https://")) {
    headers.Authorization = "Basic " + Buffer.from(`${key}:${secret}`).toString("base64");
  } else {
    // Woo no acepta Basic Auth por HTTP: usa claves en la URL (solo para pruebas locales)
    qs.set("consumer_key", key);
    qs.set("consumer_secret", secret);
  }

  const res = await fetch(`${base}/wp-json/wc/v3${path}?${qs}`, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`WooCommerce respondió ${res.status} en ${path}: ${body}`);
  }
  return {
    data: (await res.json()) as T,
    totalPages: Number(res.headers.get("x-wp-totalpages") ?? "1") || 1,
  };
}

async function wooGetAll<T>(path: string, params: Record<string, string | number> = {}) {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const { data, totalPages } = await wooGet<T[]>(path, { ...params, per_page: 100, page });
    out.push(...data);
    if (page >= totalPages || data.length === 0) break;
  }
  return out;
}

/** Prueba rápida de conexión (la usa /admin/configuracion en la etapa 5). */
export async function wooTestConnection() {
  const { data } = await wooGet<{ value: string }>("/settings/tax/woocommerce_prices_include_tax");
  return { ok: true, pricesIncludeTax: data.value === "yes" };
}

// ---------- Conversión de datos ----------

function resolveTax(taxStatus: string | undefined, taxClass: string | undefined, unknown: Set<string>): TaxRate {
  if (taxStatus && TAX_STATUS_EXEMPT.includes(taxStatus)) return 0;
  const cls = taxClass ?? "";
  if (cls in TAX_CLASS_RATES) return TAX_CLASS_RATES[cls];
  unknown.add(cls);
  return DEFAULT_TAX_RATE;
}

function pickBarcode(globalUniqueId: string | undefined, meta: WooMeta[] | undefined, sku: string | null) {
  if (globalUniqueId && globalUniqueId.trim()) return globalUniqueId.trim();
  for (const k of BARCODE_META_KEYS) {
    const m = meta?.find((x) => x.key === k);
    if (m && typeof m.value === "string" && m.value.trim()) return m.value.trim();
    if (m && typeof m.value === "number") return String(m.value);
  }
  return sku; // si no hay código de barras, el SKU hace de código
}

const clean = (s: string | undefined | null) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

type Row = {
  woo_id: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  price: number;
  tax_rate: TaxRate;
  image_url: string | null;
  category: string | null;
};

/** Productos de Woo → filas de la tabla (los variables se expanden: una fila por variación). */
async function toRows(products: WooProduct[], unknownClasses: Set<string>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const p of products) {
    const category = p.categories?.[0]?.name ?? null;
    const image = p.images?.[0]?.src ?? null;

    if (p.type === "variable") {
      const vars = await wooGetAll<WooVariation>(`/products/${p.id}/variations`);
      for (const v of vars) {
        if (v.status && v.status !== "publish") continue;
        const sku = clean(v.sku);
        const attrs = (v.attributes ?? []).map((a) => a.option).filter(Boolean).join(", ");
        const taxClass = v.tax_class === "parent" || v.tax_class === undefined ? p.tax_class : v.tax_class;
        rows.push({
          woo_id: v.id,
          sku,
          barcode: pickBarcode(v.global_unique_id, v.meta_data, sku),
          name: attrs ? `${p.name} - ${attrs}` : p.name,
          price: Number(v.price || v.regular_price || 0) || 0,
          tax_rate: resolveTax(v.tax_status, taxClass, unknownClasses),
          image_url: v.image?.src ?? image,
          category,
        });
      }
    } else {
      const sku = clean(p.sku);
      rows.push({
        woo_id: p.id,
        sku,
        barcode: pickBarcode(p.global_unique_id, p.meta_data, sku),
        name: p.name,
        price: Number(p.price || p.regular_price || 0) || 0,
        tax_rate: resolveTax(p.tax_status, p.tax_class, unknownClasses),
        image_url: image,
        category,
      });
    }
  }
  return rows;
}

/** Inserta o actualiza por woo_id (misma lógica para sync completa e incremental). */
async function upsertRows(rows: Row[], pricesIncludeTax: boolean) {
  let created = 0;
  let updated = 0;
  const client = await pool.connect();
  try {
    for (const r of rows) {
      // Un producto que antes existía SOLO en Siigo (sin woo_id) y ahora aparece en Woo con el mismo código se UNE a esa fila (origin 'ambos')
      // en vez de duplicarse. Si hay más de uno con ese código no se une (ambiguo): se inserta aparte y se reporta en la sincronización de Siigo.
      if (r.sku) {
        await client.query(
          `UPDATE products SET woo_id = $1
            WHERE id = (SELECT id FROM products WHERE woo_id IS NULL AND origin = 'siigo' AND upper(regexp_replace(sku, '\\s', '', 'g')) = upper(regexp_replace($2, '\\s', '', 'g')))
              AND (SELECT count(*) FROM products WHERE woo_id IS NULL AND origin = 'siigo' AND upper(regexp_replace(sku, '\\s', '', 'g')) = upper(regexp_replace($2, '\\s', '', 'g'))) = 1
              AND NOT EXISTS (SELECT 1 FROM products WHERE woo_id = $1)`,
          [r.woo_id, r.sku]
        );
      }
      // xmax = 0 significa que la fila fue insertada (no actualizada)
      const res = await client.query<{ inserted: boolean }>(
        // tax_rate es la tarifa EFECTIVA: si Siigo ya clasificó el producto se conserva la de Siigo (fuente fiscal).
        // Si cambia el SKU, la clasificación de Siigo deja de valer y se vuelve a consultar.
        `INSERT INTO products (woo_id, sku, barcode, name, price, tax_rate, woo_tax_rate, prices_include_tax, image_url, category, active, updated_at, woo_seen_at, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,TRUE,now(),now(),'woocommerce')
         ON CONFLICT (woo_id) DO UPDATE SET
           sku=EXCLUDED.sku, barcode=EXCLUDED.barcode, name=EXCLUDED.name, price=EXCLUDED.price,
           woo_tax_rate=EXCLUDED.woo_tax_rate,
           tax_rate = CASE WHEN products.siigo_tax_class IS NULL OR products.sku IS DISTINCT FROM EXCLUDED.sku
                           THEN EXCLUDED.woo_tax_rate ELSE products.tax_rate END,
           siigo_tax_class = CASE WHEN products.sku IS DISTINCT FROM EXCLUDED.sku THEN NULL ELSE products.siigo_tax_class END,
           prices_include_tax=EXCLUDED.prices_include_tax,
           image_url=EXCLUDED.image_url, category=EXCLUDED.category, active=TRUE, updated_at=now(), woo_seen_at=now(),
           origin = CASE WHEN products.siigo_id IS NOT NULL THEN 'ambos' ELSE 'woocommerce' END
         RETURNING (xmax = 0) AS inserted`,
        [r.woo_id, r.sku, r.barcode, r.name, r.price, r.tax_rate, pricesIncludeTax, r.image_url, r.category]
      );
      if (res.rows[0].inserted) created++;
      else updated++;
    }
  } finally {
    client.release();
  }
  return { created, updated };
}

async function fetchPricesIncludeTax() {
  const { data } = await wooGet<{ value: string }>("/settings/tax/woocommerce_prices_include_tax");
  return data.value === "yes";
}

// ---------- Sincronización ----------

export type SyncResult = {
  /** Clasificación de IVA desde Siigo (null si no se consultó o falló) */
  siigo: { checked: number; changed: number; notFound: number; ivaDiferente: number } | null;
  mode: "full" | "incremental";
  created: number;
  updated: number;
  deactivated: number;
  total: number; // productos traídos de Woo en esta sincronización
  noSku: number;
  pricesIncludeTax: boolean;
  unknownTaxClasses: string[];
};

export type SyncOutcome =
  | { status: "busy" }
  | { status: "needs_full"; reason: string }
  | { status: "ok"; result: SyncResult };

const dbNow = async () => (await query<{ t: Date }>("SELECT now() AS t")).rows[0].t;

/** Sincronización COMPLETA: trae todo, y desactiva lo que ya no está publicado en Woo. */
export async function syncProductsFull(userId?: number): Promise<SyncOutcome> {
  return withSyncLock(async (): Promise<SyncOutcome> => {
    const startedAt = await dbNow();
    const unknownClasses = new Set<string>();

    // Si no se puede saber si los precios incluyen IVA se aborta: un error aquí dañaría todos los precios.
    const pricesIncludeTax = await fetchPricesIncludeTax();
    const products = await wooGetAll<WooProduct>("/products", { status: "publish" });
    const rows = await toRows(products, unknownClasses);
    const { created, updated } = await upsertRows(rows, pricesIncludeTax);

    // Lo que ya no viene de Woo (despublicado/borrado) se desactiva, sin borrarlo (las ventas lo referencian).
    // SOLO productos con woo_id: lo que es solo de Siigo NUNCA se toca. Si un producto unido ('ambos') deja Woo, pasa a ser solo de
    // Siigo (con los datos de Siigo) y queda activo mientras Siigo lo tenga activo y sea vendible.
    const toSiigo = await query(
      `UPDATE products SET origin = 'siigo', woo_id = NULL, name = COALESCE(siigo_name, name), price = COALESCE(siigo_price, price),
              prices_include_tax = COALESCE(siigo_price_includes_tax, prices_include_tax), image_url = NULL, category = siigo_group,
              active = COALESCE(siigo_active, FALSE) AND COALESCE(siigo_type, 'Product') = 'Product', updated_at = now()
        WHERE woo_id IS NOT NULL AND origin = 'ambos' AND woo_seen_at < $1`,
      [startedAt]
    );
    const deact = await query(
      "UPDATE products SET active = FALSE, updated_at = now() WHERE active AND woo_id IS NOT NULL AND origin = 'woocommerce' AND woo_seen_at < $1",
      [startedAt]
    );

    await setSetting(SETTING_PRICES_INCLUDE_TAX, pricesIncludeTax ? "yes" : "no");
    await setSetting(SETTING_LAST_SYNC, startedAt.toISOString());

    // Clasificación fiscal de TODOS los productos según Siigo
    const siigoTax = await siigoTaxStep(syncSiigoTaxClassesAll, userId);
    const mism = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM products WHERE active AND siigo_tax_class IS NOT NULL AND woo_tax_rate <> tax_rate"
    );

    const noSkuRows = rows.filter((r) => !r.sku);
    const result: SyncResult = {
      siigo: siigoTax
        ? { checked: siigoTax.checked, changed: siigoTax.changed, notFound: siigoTax.notFound.length, ivaDiferente: mism.rows[0].n }
        : null,
      mode: "full",
      created,
      updated,
      deactivated: (deact.rowCount ?? 0),
      total: rows.length,
      noSku: noSkuRows.length,
      pricesIncludeTax,
      unknownTaxClasses: [...unknownClasses],
    };
    await writeLog(
      "sync",
      `Sync completa Woo: ${created} creados, ${updated} actualizados, ${result.deactivated} desactivados, ${result.noSku} sin SKU`,
      {
        userId,
        level: result.noSku > 0 || unknownClasses.size > 0 ? "warn" : "info",
        detail: { ...result, unidos_que_dejaron_woo_y_pasaron_a_solo_siigo: toSiigo.rowCount ?? 0, sinSku: noSkuRows.slice(0, 100).map((r) => ({ woo_id: r.woo_id, name: r.name })) },
      }
    );
    return { status: "ok", result };
  });
}

/**
 * Sincronización INCREMENTAL: solo productos nuevos o modificados desde la última sincronización exitosa.
 * No desactiva nada (no puede ver productos eliminados): eso lo hace la sincronización completa.
 */
export async function syncProductsIncremental(userId?: number): Promise<SyncOutcome> {
  return withSyncLock(async (): Promise<SyncOutcome> => {
    const last = await getSetting(SETTING_LAST_SYNC);
    if (!last) return { status: "needs_full", reason: "Aún no se ha hecho una sincronización completa" };

    const startedAt = await dbNow(); // se guarda el INICIO: lo modificado durante la sincronización se recoge en la próxima
    const unknownClasses = new Set<string>();

    const pricesIncludeTax = await fetchPricesIncludeTax();
    const storedFlag = await getSetting(SETTING_PRICES_INCLUDE_TAX);
    if (storedFlag && storedFlag !== (pricesIncludeTax ? "yes" : "no")) {
      return {
        status: "needs_full",
        reason: "Cambió la configuración de IVA incluido en precios de la tienda: haz una sincronización completa",
      };
    }

    // 2 minutos de margen hacia atrás por si hay diferencia de relojes (repetir un producto es inofensivo)
    const since = new Date(new Date(last).getTime() - 2 * 60_000).toISOString().replace(/\.\d{3}Z$/, "");
    const products = await wooGetAll<WooProduct>("/products", {
      status: "publish",
      modified_after: since,
      dates_are_gmt: "true", // la fecha va en UTC, sin depender de la zona horaria de la tienda
    });
    const rows = await toRows(products, unknownClasses);
    const { created, updated } = await upsertRows(rows, pricesIncludeTax);

    await setSetting(SETTING_LAST_SYNC, startedAt.toISOString());

    // Productos nuevos, sin verificar en Siigo o con SKU cambiado: consultar su IVA en Siigo (máx. 60 por ciclo)
    const pendingSiigo = await query<{ sku: string }>(
      "SELECT sku FROM products WHERE active AND woo_id IS NOT NULL AND sku IS NOT NULL AND siigo_tax_class IS NULL ORDER BY siigo_checked_at NULLS FIRST LIMIT 60"
    );
    const siigoTax = pendingSiigo.rows.length
      ? await siigoTaxStep(() => syncSiigoTaxClassesFor(pendingSiigo.rows.map((r) => r.sku)), userId)
      : null;

    const noSkuRows = rows.filter((r) => !r.sku);
    const result: SyncResult = {
      siigo: siigoTax ? { checked: siigoTax.checked, changed: siigoTax.changed, notFound: siigoTax.notFound.length, ivaDiferente: 0 } : null,
      mode: "incremental",
      created,
      updated,
      deactivated: 0,
      total: rows.length,
      noSku: noSkuRows.length,
      pricesIncludeTax,
      unknownTaxClasses: [...unknownClasses],
    };

    // Solo se registra si hubo cambios (corre cada 10 min en cada caja: sin cambios no se llena el log)
    if (created + updated > 0) {
      await writeLog("sync", `Sync incremental Woo: ${created} creados, ${updated} actualizados`, {
        userId,
        level: result.noSku > 0 || unknownClasses.size > 0 ? "warn" : "info",
        detail: { ...result, desde: since, sinSku: noSkuRows.slice(0, 50).map((r) => ({ woo_id: r.woo_id, name: r.name })) },
      });
    }
    return { status: "ok", result };
  });
}
