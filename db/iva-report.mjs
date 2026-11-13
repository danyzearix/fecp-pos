// npm run report:iva → docs/productos-iva-diferente.csv
// En el servidor (Docker) el CSV sale por la salida estándar para guardarlo FUERA del contenedor (ver DEPLOY.md):
//   ... run --rm -T app node db/iva-report.mjs --stdout > productos-iva-diferente.csv
// Productos cuya tarifa de IVA en WooCommerce es distinta a la de Siigo (fuente fiscal), para corregirlos en la tienda.
// Requiere haber hecho una sincronización completa (llena woo_tax_rate y siigo_tax_class).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const { rows } = await c.query(`
  SELECT sku, name, woo_tax_rate, tax_rate, siigo_tax_class
    FROM products
   WHERE active AND siigo_tax_class IS NOT NULL AND woo_tax_rate <> tax_rate
   ORDER BY siigo_tax_class, name`);
await c.end();

const siigoLabel = (cls, rate) => (cls === "Exempt" ? "Exento 0%" : cls === "Excluded" ? "Excluido" : `Gravado ${rate}%`);
const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const lines = [
  ["SKU", "Nombre", "IVA en Woo", "IVA en Siigo"].map(esc).join(";"),
  ...rows.map((r) => [r.sku, r.name, `${r.woo_tax_rate}%`, siigoLabel(r.siigo_tax_class, r.tax_rate)].map(esc).join(";")),
];

// BOM + punto y coma: Excel en español lo abre bien con tildes
const csv = "﻿" + lines.join("\r\n") + "\r\n";
if (process.argv.includes("--stdout")) {
  // Modo Docker: el CSV por la salida estándar (para guardarlo FUERA del contenedor) y el resumen por stderr
  process.stdout.write(csv);
  console.error(`OK: ${rows.length} productos con IVA diferente`);
} else {
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "productos-iva-diferente.csv");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, csv, "utf8");
  console.log(`OK: ${rows.length} productos con IVA diferente → ${out}`);
}
