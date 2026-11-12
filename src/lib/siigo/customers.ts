// Buscar o crear el cliente en Siigo antes de facturar.
import { SIIGO_DEFAULT_FISCAL_RESPONSIBILITY } from "@/config/siigo-map";
import { query } from "../db";
import { siigo } from "./client";

export type CustomerRow = {
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
  siigo_synced: boolean;
};

/** Siigo no acepta caracteres especiales en el nombre. */
const cleanName = (s: string | null | undefined) =>
  (s ?? "").replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100);

export async function ensureSiigoCustomer(c: CustomerRow): Promise<void> {
  if (c.siigo_synced) return; // ya verificado antes: no gastar peticiones

  const found = await siigo<{ results?: unknown[] }>("GET", `/v1/customers?identification=${encodeURIComponent(c.identification)}`);
  if (found.results?.length) {
    await query("UPDATE customers SET siigo_synced = TRUE WHERE id = $1", [c.id]);
    return;
  }

  const isCompany = c.id_type === "31";
  const first = cleanName(c.first_name);
  const last = cleanName(c.last_name);
  const name = isCompany ? [cleanName(c.company_name) || c.identification] : last ? [first, last] : [first || c.identification];

  const address = (c.address || process.env.POS_ADDRESS || "").trim();
  if (!address) throw new Error("El cliente no tiene dirección y POS_ADDRESS está vacío en .env.local");

  const phone = (c.phone ?? "").replace(/\D/g, "").slice(-10);
  const email = (c.email ?? "").trim();

  const body: Record<string, unknown> = {
    type: "Customer",
    person_type: isCompany ? "Company" : "Person",
    id_type: c.id_type,
    identification: c.identification,
    name,
    vat_responsible: false,
    fiscal_responsibilities: [{ code: SIIGO_DEFAULT_FISCAL_RESPONSIBILITY }],
    address: {
      address: address.slice(0, 256),
      city: {
        country_code: "Co",
        state_code: c.state_code || process.env.POS_STATE_CODE || "11",
        city_code: c.city_code || process.env.POS_CITY_CODE || "11001",
      },
    },
    comments: "Creado por FECP POS",
  };
  if (isCompany && c.check_digit) body.check_digit = c.check_digit;
  if (phone.length >= 7) body.phones = [{ number: phone }];
  body.contacts = [
    {
      first_name: (isCompany ? cleanName(c.company_name) : first || "Cliente").slice(0, 50),
      last_name: (isCompany ? "" : last).slice(0, 50),
      ...(email ? { email } : {}),
    },
  ];

  await siigo("POST", "/v1/customers", { body });
  await query("UPDATE customers SET siigo_synced = TRUE WHERE id = $1", [c.id]);
}
