import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { lookupCustomerByIdentification } from "@/lib/customer-lookup";
import { customerFullName, maskIdKiosk, maskNameKiosk } from "@/lib/customer-rules";
import { writeLog } from "@/lib/log";
import { rateLimited } from "@/lib/rate-limit";
import { SESSION_COOKIE } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Consultas permitidas por IP y por sesión en cada ventana (constantes: cámbialas aquí). */
const KIOSK_LOOKUP_MAX = 10;
const KIOSK_LOOKUP_WINDOW_MS = 10 * 60_000;
/** Toda respuesta tarda al menos esto: encontrado, no encontrado, formato inválido o Siigo caído se ven iguales desde afuera. */
const MIN_RESPONSE_MS = 1_200;

const NO_STORE = { "Cache-Control": "no-store" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** IP del cliente: Traefik AÑADE la IP real al final de X-Forwarded-For */
const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",").pop()?.trim() || req.headers.get("x-real-ip") || "desconocida";

/**
 * POST /api/kiosco/cliente  { identification }   — SOLO rol cliente (kiosco).
 * El servidor responde ÚNICAMENTE datos ya enmascarados: el navegador del kiosco no recibe nunca el nombre, el correo ni el teléfono reales.
 *   encontrado:    { found: true,  name_masked: "DAN**** MUN****", identification_masked: "1018****" }
 *   cualquier otra cosa (no existe, inactivo, formato inválido, Siigo no responde): { found: false }  — misma forma y mismo tiempo.
 * Requiere el número COMPLETO (sin búsqueda parcial). Límite por IP y por sesión (429). En los logs solo van los últimos 3 dígitos.
 */
export async function POST(req: Request) {
  const t0 = Date.now();
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  if (g.user.role !== "cliente") return NextResponse.json({ error: "Sin permiso" }, { status: 403 });

  const ip = clientIp(req);
  const session = crypto.createHash("sha256").update((await cookies()).get(SESSION_COOKIE)?.value ?? "").digest("hex").slice(0, 16);
  if (rateLimited(`kiosk-lookup:ip:${ip}`, KIOSK_LOOKUP_MAX, KIOSK_LOOKUP_WINDOW_MS) || rateLimited(`kiosk-lookup:sess:${session}`, KIOSK_LOOKUP_MAX, KIOSK_LOOKUP_WINDOW_MS)) {
    await writeLog("seguridad", "Autoservicio: demasiadas consultas de cliente (límite de frecuencia)", { level: "warn", userId: g.user.uid });
    return NextResponse.json({ error: "Demasiadas consultas. Espere unos minutos o acérquese a la caja." }, { status: 429, headers: NO_STORE });
  }

  const body = (await req.json().catch(() => null)) as { identification?: unknown } | null;
  const id = typeof body?.identification === "string" ? body.identification.trim() : "";
  // Solo dígitos y de largo razonable: sin parciales ni letras (un NIT se escribe sin dígito de verificación)
  const valid = /^\d{5,15}$/.test(id);
  let result: { found: true; name_masked: string; identification_masked: string } | { found: false } = { found: false };
  let log = "formato inválido";
  if (valid) {
    const r = await lookupCustomerByIdentification(id, { uid: g.user.uid, name: g.user.name });
    if (r.found) {
      result = { found: true, name_masked: maskNameKiosk(customerFullName(r.row)), identification_masked: maskIdKiosk(r.row.identification) };
      log = "encontrado";
    } else log = "no encontrado";
  }
  await writeLog("venta", `Autoservicio: consulta de cliente (***${id.slice(-3)}): ${log}`, { userId: g.user.uid });

  const wait = MIN_RESPONSE_MS - (Date.now() - t0);
  if (wait > 0) await sleep(wait);
  return NextResponse.json(result, { headers: NO_STORE });
}
