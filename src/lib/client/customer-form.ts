// Reglas del formulario de cliente compartidas por la caja (CheckoutModal) y el kiosco.
// Mismas reglas fiscales: checkout CORTO (datos opcionales) hasta 5 UVT de base sin IVA; COMPLETO por encima.
import dane from "@/config/dane.json";
import { CONSUMIDOR_FINAL_ID, type CustomerIn } from "../sale-types";

type Dept = { code: string; name: string; capital?: [string, string]; municipios?: [string, string][] };
export const DEPTS = dane.departamentos as unknown as Dept[];
export const citiesOf = (code: string): [string, string][] => {
  const d = DEPTS.find((x) => x.code === code);
  return d ? (d.municipios ?? (d.capital ? [d.capital] : [])) : [];
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Dígito de verificación del NIT (algoritmo DIAN) */
export function nitDv(nit: string): string {
  const w = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const d = nit.replace(/\D/g, "").split("").reverse();
  if (d.length === 0 || d.length > w.length) return "";
  const sum = d.reduce((s, ch, i) => s + Number(ch) * w[i], 0);
  const r = sum % 11;
  return String(r > 1 ? 11 - r : r);
}

/** "Maria Fernanda Lopez" → ["Maria Fernanda", "Lopez"] */
export function splitName(full: string): [string, string] {
  const t = full.trim().split(/\s+/).filter(Boolean);
  if (t.length <= 1) return [t[0] ?? "", ""];
  const k = Math.ceil(t.length / 2);
  return [t.slice(0, k).join(" "), t.slice(k).join(" ")];
}

export type CustomerFormState = {
  idType: string;
  identification: string;
  dv: string;
  company: string;
  name: string; // checkout corto: nombre y apellido en un solo campo
  first: string;
  last: string;
  email: string;
  phone: string;
  address: string;
  state: string;
  city: string;
};

export const emptyCustomerForm = (defaults: { state: string; city: string }): CustomerFormState => ({
  idType: "13", identification: "", dv: "", company: "", name: "", first: "", last: "",
  email: "", phone: "", address: "", state: defaults.state, city: defaults.city,
});

/** Primer problema del formulario (en español) o null si está bien. */
export function validateCustomerForm(f: CustomerFormState, type: "corto" | "completo"): string | null {
  const id = f.identification.trim();
  if (type === "corto") {
    if (id && !f.name.trim()) return "Escriba su nombre (o borre la cédula para comprar sin datos)";
    if (id && f.idType !== "31" && f.name.trim().split(/\s+/).length < 2) return "Escriba su nombre y apellido";
    if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) return "El correo no es válido";
    return null;
  }
  if (!id) return "Escriba su número de documento";
  if (id === CONSUMIDOR_FINAL_ID) return "Esta compra requiere sus datos reales";
  if (f.idType === "31") {
    if (!/^\d{5,15}$/.test(id)) return "El NIT debe tener solo números";
    if (!/^\d$/.test(f.dv)) return "Falta el dígito de verificación";
    if (!f.company.trim()) return "Escriba la razón social";
  } else {
    if (!f.first.trim() || !f.last.trim()) return "Escriba sus nombres y apellidos";
  }
  if (!EMAIL_RE.test(f.email.trim())) return "Escriba un correo válido";
  if (!f.address.trim()) return "Escriba su dirección";
  if (!f.state || !f.city) return "Seleccione departamento y ciudad";
  return null;
}

/** Cliente a enviar al servidor (null = Consumidor final) */
export function buildCustomerFromForm(f: CustomerFormState, type: "corto" | "completo"): CustomerIn | null {
  const id = f.identification.trim();
  if (type === "corto") {
    if (!id) return null;
    if (f.idType === "31") {
      return { id_type: "31", identification: id, check_digit: f.dv, company_name: f.name.trim(), email: f.email.trim(), phone: f.phone.trim() };
    }
    const [first, last] = splitName(f.name);
    return { id_type: f.idType, identification: id, first_name: first, last_name: last, email: f.email.trim(), phone: f.phone.trim() };
  }
  const nit = f.idType === "31";
  return {
    id_type: f.idType,
    identification: id,
    check_digit: nit ? f.dv : "",
    company_name: nit ? f.company.trim() : "",
    first_name: nit ? "" : f.first.trim(),
    last_name: nit ? "" : f.last.trim(),
    email: f.email.trim(),
    phone: f.phone.trim(),
    address: f.address.trim(),
    state_code: f.state,
    city_code: f.city,
  };
}
