import Link from "next/link";
import { requirePage } from "@/lib/auth";
import { normalizeName } from "@/lib/customers";
import { query } from "@/lib/db";
import { CONSUMIDOR_FINAL_ID, ID_TYPE_LABELS } from "@/lib/sale-types";
import { getSyncStatus } from "@/lib/siigo/customer-sync";
import type { Metadata } from "next";
import SyncPanel from "./SyncPanel";

export const metadata: Metadata = { title: "Clientes" };
export const dynamic = "force-dynamic";

type Row = {
  id: number;
  id_type: string;
  identification: string;
  check_digit: string | null;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  siigo_synced: boolean;
  active: boolean;
  compras: number;
  ultima: Date | null;
};

const TYPE: Record<string, string> = { "13": "CC", "31": "NIT", "22": "CE", "41": "Pasaporte" };
const PAGE_SIZE = 50;
const likeEsc = (s: string) => s.replace(/[\\%_]/g, "\\$&");

// Solo lectura. Corregir un cliente aquí NO lo corrige en Siigo (la API de Siigo reemplaza todos los campos al editar).
export default async function ClientesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requirePage("/admin");
  const { q = "", page: pageRaw } = await searchParams;
  const term = likeEsc(q.trim());
  const words = likeEsc(normalizeName(q));
  const page = Math.max(1, Math.floor(Number(pageRaw)) || 1);
  const sync = await getSyncStatus();

  // Filtro con índices: identificación que empieza por… o nombre que contiene… (se cuenta aparte para paginar)
  const where = `($1 = '' OR c.identification LIKE $1 || '%' OR c.search_name LIKE '%' || $2 || '%')`;
  const total = (await query<{ n: number }>(`SELECT count(*)::int AS n FROM customers c WHERE ${where}`, [term, words])).rows[0].n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const cur = Math.min(page, pages);

  const { rows } = await query<Row>(
    `SELECT c.id, c.id_type, c.identification, c.check_digit, c.first_name, c.last_name, c.company_name,
            c.email, c.phone, c.address, c.siigo_synced, c.active,
            count(s.id) FILTER (WHERE s.status <> 'anulada')::int AS compras,
            max(COALESCE(s.created_at_device, s.created_at)) FILTER (WHERE s.status <> 'anulada') AS ultima
       FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
      WHERE ${where}
      GROUP BY c.id
      ORDER BY compras DESC, c.id DESC
      LIMIT ${PAGE_SIZE} OFFSET ${(cur - 1) * PAGE_SIZE}`,
    [term, words]
  );
  const href = (p: number) => `/admin/clientes?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`;

  return (
    <div className="space-y-5 max-w-7xl min-w-0">
      <div>
        <h1 className="text-2xl font-bold text-fg">Clientes</h1>
        <p className="text-[13px] text-dim">
          Copia de los clientes de Siigo (Siigo manda: se actualizan al sincronizar) más los que se registran al vender. Solo lectura: cambiar un
          cliente aquí no lo cambia en Siigo.
        </p>
      </div>

      <SyncPanel initial={JSON.parse(JSON.stringify(sync))} />

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={q}
          placeholder="Buscar por nombre, cédula o NIT"
          className="flex-1 max-w-md bg-surface border border-field rounded-lg px-4 min-h-11 text-[15px] text-fg placeholder:text-[15px] outline-none focus:border-brand"
        />
        <button className="px-5 min-h-11 rounded-lg border border-field bg-surface text-[15px] font-medium text-body">Buscar</button>
      </form>

      <div className="bg-surface rounded-xl border border-line overflow-x-auto">
        <table className="w-full text-[14px] text-fg">
          <thead className="bg-subtle text-left text-[13px] text-body">
            <tr>
              <th className="px-4 py-2">Cliente</th>
              <th className="px-4 py-2">Documento</th>
              <th className="px-4 py-2">Correo</th>
              <th className="px-4 py-2">Teléfono</th>
              <th className="px-4 py-2">Dirección</th>
              <th className="px-4 py-2 text-right">Compras</th>
              <th className="px-4 py-2">Última compra</th>
              <th className="px-4 py-2">En Siigo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((c) => {
              const isCF = c.identification === CONSUMIDOR_FINAL_ID;
              const name = isCF ? "Consumidor final" : c.company_name || [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
              return (
                <tr key={c.id}>
                  <td className="px-4 py-2 font-medium">
                    {name}
                    {!c.active && <span className="ml-2 text-[12px] font-semibold px-2 py-0.5 rounded-full bg-off-soft text-off-ink">Inactivo</span>}
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap" title={ID_TYPE_LABELS[c.id_type]}>
                    {TYPE[c.id_type] ?? ID_TYPE_LABELS[c.id_type] ?? c.id_type} {c.identification}
                    {c.check_digit ? `-${c.check_digit}` : ""}
                  </td>
                  <td className="px-4 py-2">{c.email || "—"}</td>
                  <td className="px-4 py-2">{c.phone || "—"}</td>
                  <td className="px-4 py-2">{c.address || "—"}</td>
                  <td className="px-4 py-2 text-right font-semibold">{c.compras}</td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {c.ultima ? c.ultima.toLocaleDateString("es-CO", { timeZone: "America/Bogota" }) : "—"}
                  </td>
                  <td className="px-4 py-2">
                    {c.siigo_synced ? <span className="text-ok-ink">✓ Sí</span> : <span className="text-dim">Por verificar</span>}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-dim">
                  No hay clientes con ese criterio.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[14px] text-body">
        <span>
          {total.toLocaleString("es-CO")} cliente{total === 1 ? "" : "s"} · página {cur} de {pages}
        </span>
        {cur > 1 && (
          <Link href={href(cur - 1)} className="px-4 min-h-11 inline-flex items-center rounded-lg border border-field bg-surface font-medium">
            ← Anterior
          </Link>
        )}
        {cur < pages && (
          <Link href={href(cur + 1)} className="px-4 min-h-11 inline-flex items-center rounded-lg border border-field bg-surface font-medium">
            Siguiente →
          </Link>
        )}
      </div>
    </div>
  );
}
