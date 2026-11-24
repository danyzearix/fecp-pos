// Clasificación tributaria de los productos según Siigo (fuente fiscal).
// Actualiza products.siigo_tax_class y la tarifa efectiva products.tax_rate.
import { pool } from "../db";
import { siigo } from "./client";

type SiigoProduct = {
  code: string;
  active?: boolean;
  tax_classification?: "Taxed" | "Exempt" | "Excluded";
  taxes?: { id: number; type: string; percentage: number }[];
};
type Page = { pagination?: { total_results: number }; results?: SiigoProduct[] };

export type TaxClass = "Taxed" | "Exempt" | "Excluded";

/** Siigo → (clase, tarifa). null si la tarifa no es 0/5/19 (se deja la de Woo y se avisa). */
function classify(p: SiigoProduct): { cls: TaxClass; rate: number } | null {
  const cls = p.tax_classification ?? "Taxed";
  if (cls === "Exempt" || cls === "Excluded") return { cls, rate: 0 };
  const iva = (p.taxes ?? []).find((t) => t.type === "IVA");
  const rate = iva ? Number(iva.percentage) : 0;
  if (![0, 5, 19].includes(rate)) return null;
  return { cls: "Taxed", rate };
}

export type SiigoTaxSyncResult = { checked: number; changed: number; notFound: string[]; oddRates: string[] };

async function apply(found: Map<string, SiigoProduct>, skus: string[]): Promise<SiigoTaxSyncResult> {
  const codes: string[] = [];
  const classes: string[] = [];
  const rates: number[] = [];
  const notFound: string[] = [];
  const oddRates: string[] = [];
  for (const sku of skus) {
    const p = found.get(sku);
    if (!p) {
      notFound.push(sku);
      continue;
    }
    const c = classify(p);
    if (!c) {
      oddRates.push(sku);
      continue;
    }
    codes.push(sku);
    classes.push(c.cls);
    rates.push(c.rate);
  }

  const client = await pool.connect();
  try {
    // updated_at solo cambia si algo cambió: así las cajas se enteran (versión del catálogo)
    const r = await client.query(
      `UPDATE products p SET siigo_tax_class = v.cls, tax_rate = v.rate, updated_at = now()
         FROM unnest($1::text[], $2::text[], $3::int[]) AS v(sku, cls, rate)
        WHERE p.sku = v.sku AND p.woo_id IS NOT NULL AND (p.siigo_tax_class IS DISTINCT FROM v.cls OR p.tax_rate <> v.rate)`,
      [codes, classes, rates]
    );
    await client.query("UPDATE products SET siigo_checked_at = now() WHERE woo_id IS NOT NULL AND sku = ANY($1::text[])", [skus]);
    return { checked: skus.length, changed: r.rowCount ?? 0, notFound, oddRates };
  } finally {
    client.release();
  }
}

/** Sincronización completa: descarga todo el catálogo de Siigo (páginas de 100, respetando el límite). */
export async function syncSiigoTaxClassesAll(): Promise<SiigoTaxSyncResult> {
  const found = new Map<string, SiigoProduct>();
  for (let page = 1; ; page++) {
    const r = await siigo<Page>("GET", `/v1/products?page=${page}&page_size=100`);
    for (const p of r.results ?? []) if (p.code && p.active !== false) found.set(p.code, p);
    const total = r.pagination?.total_results ?? 0;
    if (!r.results?.length || page * 100 >= total) break;
  }
  const { rows } = await pool.query<{ sku: string }>("SELECT sku FROM products WHERE active AND woo_id IS NOT NULL AND sku IS NOT NULL");
  return apply(found, rows.map((x) => x.sku));
}

/** Sincronización incremental: consulta en Siigo solo los SKU indicados (uno por uno). */
export async function syncSiigoTaxClassesFor(skus: string[]): Promise<SiigoTaxSyncResult> {
  const found = new Map<string, SiigoProduct>();
  for (const sku of skus) {
    const r = await siigo<Page>("GET", `/v1/products?code=${encodeURIComponent(sku)}`);
    const p = r.results?.find((x) => x.code === sku && x.active !== false);
    if (p) found.set(sku, p);
  }
  return apply(found, skus);
}
