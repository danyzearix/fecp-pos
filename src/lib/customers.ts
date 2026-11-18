// Clientes del POS: búsqueda para la caja (solo admin y cajero). Aquí NO hay llamadas a Siigo.
import { query } from "./db";
import { CONSUMIDOR_FINAL_ID } from "./sale-types";

/** Lo mínimo que la caja necesita de un cliente para facturar (nunca incluye el id interno de Siigo). */
export const PICKER_COLUMNS = `id, id_type, identification, check_digit, first_name, last_name, company_name, email, phone, address, state_code, city_code`;

export const MIN_SEARCH_CHARS = 3;
export const MAX_SEARCH_RESULTS = 10;

/** Misma normalización que la columna search_name de la base: minúsculas y sin tildes. */
export const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (ch) => "aeiouun"["áéíóúüñ".indexOf(ch)])
    .replace(/\s+/g, " ")
    .trim();

/** Escapa los comodines de LIKE que escriba el usuario */
const likeEsc = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export type PickerRow = {
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
  state_code: string | null;
  city_code: string | null;
};

/**
 * Busca clientes ACTIVOS por identificación (empieza por…) o por nombre (contiene todas las palabras). Máximo 10.
 * Un cliente inactivo en Siigo no se ofrece. El Consumidor final tiene su propio botón: no sale en la búsqueda.
 */
export async function searchCustomers(raw: string): Promise<PickerRow[]> {
  const q = raw.trim().slice(0, 60);
  if (q.length < MIN_SEARCH_CHARS) return [];
  const params: unknown[] = [CONSUMIDOR_FINAL_ID, q];
  const conds: string[] = [];
  if (!/\s/.test(q)) {
    params.push(likeEsc(q));
    conds.push(`identification LIKE $${params.length} || '%'`);
  }
  if (/[^\d\s]/.test(q)) {
    // hay letras: también por nombre (todas las palabras, hasta 4)
    const words = normalizeName(q).split(" ").filter(Boolean).slice(0, 4);
    const w: string[] = [];
    for (const word of words) {
      params.push(likeEsc(word));
      w.push(`search_name LIKE '%' || $${params.length} || '%'`);
    }
    if (w.length) conds.push(`(${w.join(" AND ")})`);
  }
  if (!conds.length) return [];
  const { rows } = await query<PickerRow>(
    `SELECT ${PICKER_COLUMNS} FROM customers
      WHERE active AND identification <> $1 AND (${conds.join(" OR ")})
      ORDER BY (identification = $2) DESC, identification
      LIMIT ${MAX_SEARCH_RESULTS}`,
    params
  );
  return rows;
}

/** ¿Esa identificación exacta existe localmente como cliente INACTIVO? (para avisar en vez de consultar a Siigo) */
export async function isInactiveCustomer(identification: string): Promise<boolean> {
  const r = await query("SELECT 1 FROM customers WHERE identification = $1 AND NOT active", [identification]);
  return (r.rowCount ?? 0) > 0;
}
