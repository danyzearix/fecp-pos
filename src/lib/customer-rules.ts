// Reglas de clientes (código puro: lo usan el servidor y el navegador): qué datos faltan para facturar y cómo se ofuscan.
import type { CustomerIn } from "./sale-types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Datos que faltan para facturar a nombre de un cliente identificado. Los nombres coinciden con los campos del formulario:
 *  company (razón social), first / last (nombres y apellidos), dv (dígito de verificación del NIT), email, address, state, city.
 * Una empresa (NIT, o un cliente que solo tiene razón social) pide razón social; una persona, nombres y apellidos.
 */
export type MissingField = "company" | "first" | "last" | "dv" | "email" | "address" | "state" | "city";

export const MISSING_LABEL: Record<MissingField, string> = {
  company: "razón social",
  first: "nombres",
  last: "apellidos",
  dv: "dígito de verificación",
  email: "correo",
  address: "dirección",
  state: "departamento",
  city: "ciudad",
};

const blank = (v: unknown) => !(typeof v === "string" && v.trim());

export const isCompanyCustomer = (c: Pick<CustomerIn, "id_type" | "company_name" | "first_name" | "last_name">) =>
  c.id_type === "31" || (!blank(c.company_name) && blank(c.first_name) && blank(c.last_name));

export function missingCustomerFields(c: CustomerIn): MissingField[] {
  const out: MissingField[] = [];
  if (isCompanyCustomer(c)) {
    if (blank(c.company_name)) out.push("company");
    if (c.id_type === "31" && !/^\d$/.test(String(c.check_digit ?? "").trim())) out.push("dv");
  } else {
    if (blank(c.first_name)) out.push("first");
    if (blank(c.last_name)) out.push("last");
  }
  if (!EMAIL_RE.test(String(c.email ?? "").trim())) out.push("email");
  if (blank(c.address)) out.push("address");
  if (blank(c.state_code)) out.push("state");
  if (blank(c.city_code)) out.push("city");
  return out;
}

/** Nombre para mostrar: razón social o nombres y apellidos */
export const customerFullName = (c: Pick<CustomerIn, "company_name" | "first_name" | "last_name">) =>
  (c.company_name ?? "").trim() || [c.first_name, c.last_name].map((x) => (x ?? "").trim()).filter(Boolean).join(" ");

// ---------------------------------------------------------------------------
// Ofuscación
// ---------------------------------------------------------------------------

/** d***@gmail.com — la primera letra y el dominio; el largo real de la parte local no se revela */
export function maskEmail(email: string | null | undefined): string {
  const e = (email ?? "").trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return "";
  return `${e[0]}***${e.slice(at)}`;
}

/** 300***1234 — los 3 primeros y los 4 últimos dígitos */
export function maskPhone(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  if (d.length < 5) return "";
  return d.length >= 8 ? `${d.slice(0, 3)}***${d.slice(-4)}` : `${d.slice(0, 1)}***${d.slice(-2)}`;
}

/**
 * KIOSCO: de cada palabra, las 3 primeras letras + 4 asteriscos fijos ("DAN**** MUN**** ROD****"). Siempre 7 caracteres por
 * palabra: el largo real del nombre no se puede deducir (una palabra de menos de 3 letras se completa con asteriscos).
 */
export function maskNameKiosk(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .map((w) => (w.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 3).toUpperCase() + "***").slice(0, 3).padEnd(3, "*") + "****")
    .join(" ");
}

/** KIOSCO: los 4 primeros dígitos + 4 asteriscos fijos ("1018****"). Si el número es muy corto se muestran menos dígitos. */
export function maskIdKiosk(identification: string): string {
  const id = identification.trim();
  const shown = Math.min(4, Math.max(1, id.length - 2));
  return id.slice(0, shown) + "****";
}
