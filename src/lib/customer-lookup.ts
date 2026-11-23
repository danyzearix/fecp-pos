// ÚNICO lugar donde se busca un cliente por su número de documento (lo usan la caja y el kiosco):
//   1) en la tabla local customers (la que se sincroniza con Siigo);
//   2) si no está, UN intento en vivo a Siigo (GET /v1/customers?identification=…) con timeout de 4 s y sin pasar del límite de
//      peticiones por minuto; si falla, expira o no hay cupo, se trata como "no encontrado".
// El servidor es quien decide qué se devuelve al navegador (ver las rutas): aquí se entrega la fila completa solo a código del servidor.
import { PICKER_COLUMNS, type PickerRow } from "./customers";
import { query } from "./db";
import { customerFullName, maskEmail, maskPhone, missingCustomerFields, type MissingField } from "./customer-rules";
import { CONSUMIDOR_FINAL_ID, ID_TYPE_LABELS } from "./sale-types";
import { liveLookupCustomer } from "./siigo/customer-sync";

/** El mismo formato que acepta el POS para un documento (parseCustomer) */
export const ID_FORMAT = /^[0-9A-Za-z-]{3,20}$/;

export type LookupReason = "no_valido" | "no_existe" | "inactivo" | "siigo_error" | "limite";
export type LookupResult =
  | { found: true; row: PickerRow; source: "local" | "siigo" }
  | { found: false; reason: LookupReason };

export async function lookupCustomerByIdentification(identification: string, user: { uid: number; name: string }): Promise<LookupResult> {
  const id = identification.trim();
  if (!ID_FORMAT.test(id) || id === CONSUMIDOR_FINAL_ID) return { found: false, reason: "no_valido" };

  const local = await query<PickerRow & { active: boolean }>(`SELECT ${PICKER_COLUMNS}, active FROM customers WHERE identification = $1`, [id]);
  const row = local.rows[0];
  if (row) {
    if (!row.active) return { found: false, reason: "inactivo" };
    return { found: true, row, source: "local" };
  }
  const live = await liveLookupCustomer(id, user);
  if (live.found) return { found: true, row: live.found, source: "siigo" };
  return { found: false, reason: live.reason === "no_valido" ? "no_valido" : live.reason };
}

// ---------------------------------------------------------------------------
// Lo que ve el CAJERO: nombre completo, tipo y número de documento; correo y teléfono SIEMPRE ofuscados.
// ---------------------------------------------------------------------------

export type CajaCustomerView = {
  id_type: string;
  id_type_label: string;
  identification: string;
  check_digit: string;
  name: string;
  /** d***@gmail.com ("" si no tiene) */
  email_masked: string;
  /** 300***1234 ("" si no tiene) */
  phone_masked: string;
  /** datos obligatorios para la factura que le faltan (solo esos se piden; los demás no se tocan) */
  missing: MissingField[];
  source: "local" | "siigo";
};

export function cajaCustomerView(row: PickerRow, source: "local" | "siigo"): CajaCustomerView {
  return {
    id_type: row.id_type,
    id_type_label: ID_TYPE_LABELS[row.id_type] ?? row.id_type,
    identification: row.identification,
    check_digit: row.check_digit ?? "",
    name: customerFullName(row),
    email_masked: maskEmail(row.email),
    phone_masked: maskPhone(row.phone),
    missing: missingCustomerFields(row),
    source,
  };
}
