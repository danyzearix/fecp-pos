import { requirePage } from "@/lib/auth";
import { query } from "@/lib/db";
import { isDateStr, todayBogota } from "@/lib/sales";

type Row = { id: number; level: string; type: string; message: string; detail: unknown; created_at: Date; user_name: string | null };

const TYPES = ["venta", "factura", "sync", "login", "error", "admin", "seguridad", "pago"];
const LEVELS = ["info", "warn", "error"];
const LEVEL_CLS: Record<string, string> = {
  info: "bg-brand-soft text-brand-ink",
  warn: "bg-warn-soft text-warn-ink",
  error: "bg-err-soft text-err-ink",
};
const LIMIT = 300;

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; type?: string; level?: string }>;
}) {
  await requirePage("/admin");
  const sp = await searchParams;
  const today = todayBogota();
  let from = isDateStr(sp.from) ? sp.from : today;
  let to = isDateStr(sp.to) ? sp.to : from;
  if (from > to) [from, to] = [to, from];
  const type = TYPES.includes(sp.type ?? "") ? sp.type! : "";
  const level = LEVELS.includes(sp.level ?? "") ? sp.level! : "";

  const { rows } = await query<Row>(
    `SELECT l.id, l.level, l.type, l.message, l.detail, l.created_at, u.name AS user_name
       FROM logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE (l.created_at AT TIME ZONE 'America/Bogota')::date BETWEEN $1::date AND $2::date
        AND ($3 = '' OR l.type = $3) AND ($4 = '' OR l.level = $4)
      ORDER BY l.id DESC LIMIT ${LIMIT}`,
    [from, to, type, level]
  );

  const sel = "mt-1 block border border-field rounded-lg px-3 min-h-11 text-[14px] bg-surface text-fg";
  const lab = "text-[13px] font-semibold text-body";

  return (
    <div className="space-y-5 max-w-7xl min-w-0 text-fg">
      <div>
        <h1 className="text-2xl font-bold">Logs</h1>
        <p className="text-[13px] text-dim">Ventas, intentos de facturación (con el error completo), sincronizaciones, inicios de sesión y cambios de administración.</p>
      </div>

      <form className="flex items-end gap-3 flex-wrap">
        <label className={lab}>Desde<input type="date" name="from" defaultValue={from} max={today} className={sel} /></label>
        <label className={lab}>Hasta<input type="date" name="to" defaultValue={to} max={today} className={sel} /></label>
        <label className={lab}>Tipo
          <select name="type" defaultValue={type} className={sel}>
            <option value="">Todos</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className={lab}>Nivel
          <select name="level" defaultValue={level} className={sel}>
            <option value="">Todos</option>
            {LEVELS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <button className="px-5 min-h-11 rounded-lg bg-brand text-white font-semibold text-[14px]">Filtrar</button>
      </form>

      <div className="bg-surface rounded-xl border border-line overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead className="bg-subtle text-left text-[13px] text-body">
            <tr>
              <th className="px-4 py-2">Fecha</th>
              <th className="px-4 py-2">Nivel</th>
              <th className="px-4 py-2">Tipo</th>
              <th className="px-4 py-2">Usuario</th>
              <th className="px-4 py-2">Mensaje</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="px-4 py-2 whitespace-nowrap text-[13px]">
                  {r.created_at.toLocaleString("es-CO", { timeZone: "America/Bogota", dateStyle: "short", timeStyle: "medium" })}
                </td>
                <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded-full text-[12px] font-semibold ${LEVEL_CLS[r.level] ?? ""}`}>{r.level}</span></td>
                <td className="px-4 py-2">{r.type}</td>
                <td className="px-4 py-2 whitespace-nowrap">{r.user_name ?? "—"}</td>
                <td className="px-4 py-2">
                  <div>{r.message}</div>
                  {r.detail != null && (
                    <details className="mt-1">
                      <summary className="text-[12px] text-brand-text cursor-pointer">Ver detalle</summary>
                      <pre className="mt-1 max-h-80 overflow-auto bg-subtle border border-line rounded p-2 text-[12px] text-body whitespace-pre-wrap break-all">
                        {JSON.stringify(r.detail, null, 2)}
                      </pre>
                    </details>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-dim">Sin registros con esos filtros.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {rows.length === LIMIT && <p className="text-[13px] text-dim">Mostrando los {LIMIT} más recientes. Acota las fechas o filtra por tipo.</p>}
    </div>
  );
}
