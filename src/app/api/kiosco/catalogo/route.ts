import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { query } from "@/lib/db";

/** Catálogo del kiosco: solo productos activos CON SKU (los demás no se pueden facturar). Los precios son informativos; el cobro los recalcula. */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const { rows } = await query(
    `SELECT id, sku, barcode, name, price::float8 AS price, tax_rate, prices_include_tax, image_url, category
       FROM products WHERE active AND sku IS NOT NULL AND sku <> '' ORDER BY name`
  );
  return NextResponse.json({ products: rows }, { headers: { "Cache-Control": "no-store" } });
}
