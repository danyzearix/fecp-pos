import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { getCatalogVersion } from "@/lib/catalog-version";
import { query } from "@/lib/db";

// Catálogo completo para la caja (se guarda en memoria y en localStorage del navegador).
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;

  const version = await getCatalogVersion(); // se lee antes que los productos: si algo cambia en medio, la próxima comparación lo detecta
  const { rows } = await query(
    `SELECT id, sku, barcode, name, price::float8 AS price, tax_rate, prices_include_tax,
            image_url, category
       FROM products WHERE active ORDER BY name`
  );
  return NextResponse.json({ products: rows, version }, { headers: { "Cache-Control": "no-store" } });
}
