import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { isInactiveCustomer, MAX_SEARCH_RESULTS, MIN_SEARCH_CHARS, searchCustomers } from "@/lib/customers";
import { rateLimited } from "@/lib/rate-limit";
import { liveLookupCustomer } from "@/lib/siigo/customer-sync";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** Consultas en vivo a Siigo por usuario y por minuto (comparten el límite de Siigo con la facturación) */
const LIVE_MAX_PER_MINUTE = 12;

/**
 * GET /api/customers?q=…  → busca clientes ACTIVOS por identificación (empieza por…) o por nombre. Mínimo 3 caracteres, máximo 10 resultados.
 * SOLO admin y cajero (tabla de permisos + comprobación aquí). El rol cliente (kiosco) NUNCA puede leer, buscar ni autocompletar clientes.
 *
 * GET /api/customers?q=<cédula exacta>&live=1  → si esa identificación NO está en la copia local, la consulta en Siigo (solo lectura),
 * la guarda y la devuelve. Límite por usuario: 12 por minuto.
 */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  if (g.user.role !== "admin" && g.user.role !== "cajero") return NextResponse.json({ error: "Sin permiso" }, { status: 403 });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < MIN_SEARCH_CHARS) {
    return NextResponse.json({ error: `Escribe al menos ${MIN_SEARCH_CHARS} caracteres para buscar`, customers: [] }, { status: 400, headers: NO_STORE });
  }

  const customers = (await searchCustomers(q)).slice(0, MAX_SEARCH_RESULTS);
  const live = url.searchParams.get("live") === "1";
  const exactLocal = customers.some((c) => c.identification === q);
  if (!live || exactLocal) return NextResponse.json({ customers }, { headers: NO_STORE });

  // ---- Búsqueda en vivo en Siigo: solo para una identificación exacta que no está en la copia local ----
  if (!/^[0-9A-Za-z-]{5,20}$/.test(q)) return NextResponse.json({ customers }, { headers: NO_STORE });
  if (await isInactiveCustomer(q)) {
    return NextResponse.json({ customers, notice: "Este cliente está inactivo en Siigo." }, { headers: NO_STORE });
  }
  if (rateLimited(`cust-live:${g.user.uid}`, LIVE_MAX_PER_MINUTE, 60_000)) {
    return NextResponse.json(
      { customers, error: "Demasiadas consultas a Siigo seguidas. Espera un momento o registra al cliente al cobrar." },
      { status: 429, headers: NO_STORE }
    );
  }
  const r = await liveLookupCustomer(q, { uid: g.user.uid, name: g.user.name });
  if (r.found) return NextResponse.json({ customers: [r.found, ...customers], live: true }, { headers: NO_STORE });
  const notice =
    r.reason === "inactivo"
      ? "Este cliente está inactivo en Siigo."
      : r.reason === "siigo_error"
        ? "No se pudo consultar a Siigo. Se podrá registrar al cobrar."
        : "No está en Siigo. Se podrá registrar al cobrar.";
  return NextResponse.json({ customers, notice, live: true }, { headers: NO_STORE });
}
