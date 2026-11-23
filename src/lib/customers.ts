// Clientes del POS: columnas que necesita la caja para facturar y utilidades de texto. Aquí NO hay llamadas a Siigo.

/** Lo mínimo que la caja necesita de un cliente para facturar (nunca incluye el id interno de Siigo). */
export const PICKER_COLUMNS = `id, id_type, identification, check_digit, first_name, last_name, company_name, email, phone, address, state_code, city_code`;

/** Misma normalización que la columna search_name de la base: minúsculas y sin tildes. */
export const normalizeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[áéíóúüñ]/g, (ch) => "aeiouun"["áéíóúüñ".indexOf(ch)])
    .replace(/\s+/g, " ")
    .trim();

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
