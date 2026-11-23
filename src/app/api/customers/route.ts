import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { cajaCustomerView, ID_FORMAT, lookupCustomerByIdentification } from "@/lib/customer-lookup";
import { rateLimited } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** Consultas por usuario y por minuto (las que no están en la copia local gastan una petición a Siigo) */
const LOOKUPS_PER_MINUTE = 20;

/**
 * GET /api/customers?identification=<número de documento>  → CAJA (admin y cajero). Búsqueda por documento COMPLETO (sin parciales).
 * Primero en la tabla local (sincronizada con Siigo); si no está, un solo intento en vivo a Siigo (4 s; si falla = "no encontrado").
 * Responde nombre completo, tipo y número de documento; el correo y el teléfono van SIEMPRE ofuscados (d***@gmail.com, 300***1234)
 * y se indica qué datos obligatorios le faltan. El rol cliente (kiosco) NO usa esta ruta (403): tiene la suya, con máscara total.
 */
export async function GET(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  if (g.user.role !== "admin" && g.user.role !== "cajero") return NextResponse.json({ error: "Sin permiso" }, { status: 403 });

  const id = (new URL(req.url).searchParams.get("identification") ?? "").trim();
  if (!ID_FORMAT.test(id)) return NextResponse.json({ error: "Escribe el número de documento completo", found: false }, { status: 400, headers: NO_STORE });
  if (rateLimited(`cust-lookup:${g.user.uid}`, LOOKUPS_PER_MINUTE, 60_000)) {
    return NextResponse.json({ error: "Demasiadas consultas seguidas. Espera un momento.", found: false }, { status: 429, headers: NO_STORE });
  }

  const r = await lookupCustomerByIdentification(id, { uid: g.user.uid, name: g.user.name });
  if (r.found) return NextResponse.json({ found: true, customer: cajaCustomerView(r.row, r.source) }, { headers: NO_STORE });
  const notice =
    r.reason === "inactivo"
      ? "Este cliente está inactivo en Siigo."
      : r.reason === "siigo_error" || r.reason === "limite"
        ? "No se pudo consultar a Siigo; se trata como no encontrado."
        : "";
  return NextResponse.json({ found: false, reason: r.reason, notice }, { headers: NO_STORE });
}
