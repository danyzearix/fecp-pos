// El SERVIDOR decide quién es el cliente de una venta. El navegador solo manda tipo y número de documento (más, si hace falta,
// los datos que faltaban o los de un cliente NUEVO); todo lo demás sale de la tabla customers. Nunca se sobrescribe un dato ya guardado.
import { PICKER_COLUMNS, type PickerRow } from "./customers";
import { MISSING_LABEL, missingCustomerFields, type MissingField } from "./customer-rules";
import { query } from "./db";
import { CONSUMIDOR_FINAL_ID, type CustomerIn } from "./sale-types";

/** Rama que se registra en los logs (sin datos personales) */
export type CustomerBranch = "consumidor_final" | "cliente_existente" | "cliente_nuevo";

export type ResolvedCustomer =
  | {
      ok: true;
      branch: CustomerBranch;
      /** el cliente tal como quedará para la venta (lo guardado + lo que se completó) */
      merged: CustomerIn | null;
      /** lo único que se puede ESCRIBIR en la tabla: un cliente existente → solo tipo, número y los campos obligatorios que le faltaban */
      toStore: CustomerIn | null;
    }
  | { ok: false; error: string };

const FIELDS = ["check_digit", "first_name", "last_name", "company_name", "email", "phone", "address", "state_code", "city_code"] as const;
const FIELD_OF: Record<MissingField, (typeof FIELDS)[number]> = {
  company: "company_name", first: "first_name", last: "last_name", dv: "check_digit", email: "email", address: "address", state: "state_code", city: "city_code",
};

/**
 * - null o 222222222222 → consumidor final.
 * - Existe en customers → cliente existente. En la CAJA los datos que manda el navegador solo llenan campos VACÍOS; en el KIOSCO
 *   (source 'kiosco') se ignoran por completo (nadie puede completar ni cambiar los datos de otra persona desde la pantalla).
 * - No existe → cliente nuevo, con los datos que manda el navegador.
 * `require`: cuándo exigir los datos completos para facturar ('always' en la caja si el cliente está identificado o hay crédito;
 * 'new_only' en el kiosco: un cliente nuevo debe traer todos sus datos, uno existente ya tiene los suyos).
 */
export async function resolveSaleCustomer(
  input: CustomerIn | null,
  opts: { source: "caja" | "kiosco"; require: "always" | "new_only" | "never"; credit?: boolean }
): Promise<ResolvedCustomer> {
  if (!input || input.identification === CONSUMIDOR_FINAL_ID) return { ok: true, branch: "consumidor_final", merged: null, toStore: null };

  const found = (await query<PickerRow>(`SELECT ${PICKER_COLUMNS} FROM customers WHERE identification = $1`, [input.identification])).rows[0];
  let merged: CustomerIn;
  let toStore: CustomerIn;
  let branch: CustomerBranch;
  if (found) {
    branch = "cliente_existente";
    merged = { id_type: found.id_type, identification: found.identification };
    toStore = { id_type: found.id_type, identification: found.identification };
    for (const k of FIELDS) merged[k] = found[k];
    // Solo se completan los datos OBLIGATORIOS que le faltaban al cliente (nada más; lo guardado nunca se cambia). El kiosco no completa nada.
    if (opts.source === "caja") {
      for (const m of missingCustomerFields(found)) {
        const k = FIELD_OF[m];
        const v = (input[k] ?? "").trim();
        if (v) {
          merged[k] = v;
          toStore[k] = v;
        }
      }
    }
  } else {
    branch = "cliente_nuevo";
    merged = { ...input };
    toStore = { ...input };
  }

  const needs = opts.require === "always" || (opts.require === "new_only" && branch === "cliente_nuevo");
  if (needs) {
    const missing = missingCustomerFields(merged);
    if (missing.length) {
      return {
        ok: false,
        error: opts.credit
          ? "El Crédito FECP exige los datos completos del cliente (nombre, correo, dirección, departamento y ciudad)"
          : `Faltan datos del cliente para la factura: ${missing.map((m) => MISSING_LABEL[m]).join(", ")}`,
      };
    }
  }
  return { ok: true, branch, merged, toStore };
}
