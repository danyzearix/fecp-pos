import { requirePage } from "@/lib/auth";
import { query } from "@/lib/db";
import { formatCOP } from "@/lib/money";
import { getSetting, SETTING_LAST_SYNC } from "@/lib/settings";
import SyncButton from "./SyncButton";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Productos" };

type Row = {
  id: number;
  sku: string | null;
  barcode: string | null;
  name: string;
  price: number;
  tax_rate: number;
  category: string | null;
  active: boolean;
};

const LIMIT = 200;

export default async function ProductosPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePage("/admin");
  const { q = "" } = await searchParams;
  const term = q.trim().replace(/[\\%_]/g, "\\$&");

  const lastSync = await getSetting(SETTING_LAST_SYNC);
  const [{ rows }, noSku, counts] = await Promise.all([
    query<Row>(
      `SELECT id, sku, barcode, name, price::float8 AS price, tax_rate, category, active
         FROM products
        WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR sku ILIKE '%' || $1 || '%' OR barcode ILIKE '%' || $1 || '%'
        ORDER BY active DESC, name LIMIT ${LIMIT}`,
      [term]
    ),
    query<{ id: number; name: string }>(
      "SELECT id, name FROM products WHERE active AND (sku IS NULL OR sku = '') ORDER BY name"
    ),
    query<{ active: number; inactive: number }>(
      "SELECT count(*) FILTER (WHERE active)::int AS active, count(*) FILTER (WHERE NOT active)::int AS inactive FROM products"
    ),
  ]);

  return (
    <div className="space-y-6 max-w-6xl min-w-0">
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Productos</h1>
          <p className="text-base text-dim">
            {counts.rows[0].active} activos · {counts.rows[0].inactive} desactivados
          </p>
          <p className="text-[13px] text-dim">
            Última sincronización exitosa:{" "}
            {lastSync
              ? new Date(lastSync).toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "short" })
              : "nunca"}
            . Las cajas traen los cambios solas cada 10 min; usa “Sincronizar productos” para la sincronización completa
            (detecta productos eliminados).
          </p>
        </div>
        <SyncButton />
      </div>

      {noSku.rows.length > 0 && (
        <div className="bg-warn-soft border border-warn-line rounded-xl p-4">
          <h2 className="font-semibold text-warn-ink text-base">
            ⚠ {noSku.rows.length} productos sin SKU: no se pueden facturar
          </h2>
          <p className="text-sm text-warn-ink mb-2">Agrega el SKU en WooCommerce y vuelve a sincronizar.</p>
          <ul className="text-sm text-warn-ink columns-2 max-h-40 overflow-auto">
            {noSku.rows.map((p) => (
              <li key={p.id}>{p.name}</li>
            ))}
          </ul>
        </div>
      )}

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Buscar por nombre, SKU o código"
          className="flex-1 max-w-md bg-surface border border-field rounded-lg px-4 min-h-11 text-base text-fg placeholder:text-base outline-none focus:border-brand"
        />
        <button className="px-5 min-h-11 rounded-lg border border-field bg-surface text-base font-medium text-body">Buscar</button>
      </form>

      <div className="bg-surface rounded-xl border border-line overflow-x-auto">
        <table className="w-full text-base">
          <thead className="bg-subtle text-left text-sm text-soft">
            <tr>
              <th className="px-4 py-2">Nombre</th>
              <th className="px-4 py-2">SKU</th>
              <th className="px-4 py-2">Código</th>
              <th className="px-4 py-2">Categoría</th>
              <th className="px-4 py-2 text-right">Precio</th>
              <th className="px-4 py-2 text-right">IVA</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((p) => (
              <tr key={p.id} className={p.active ? "" : "text-dim"}>
                <td className="px-4 py-2">
                  {p.name}
                  {!p.active && <span className="ml-2 text-xs bg-off-soft rounded px-1.5">desactivado</span>}
                </td>
                <td className="px-4 py-2">{p.sku ?? <span className="text-warn-ink">Sin SKU</span>}</td>
                <td className="px-4 py-2">{p.barcode ?? "—"}</td>
                <td className="px-4 py-2">{p.category ?? "—"}</td>
                <td className="px-4 py-2 text-right">{formatCOP(p.price)}</td>
                <td className="px-4 py-2 text-right">{p.tax_rate}%</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-dim">
                  Sin productos. Presiona “Sincronizar productos”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length === LIMIT && <p className="text-sm text-dim">Mostrando los primeros {LIMIT}. Usa el buscador para acotar.</p>}
    </div>
  );
}
