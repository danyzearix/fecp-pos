// Cliente HTTP de Siigo: token en memoria (renovado antes de vencer), límite de peticiones,
// timeouts y errores legibles. NUNCA registra el token ni las credenciales.
import { SIIGO_DEFAULT_TIMEOUT_MS, SIIGO_MAX_REQUESTS_PER_MINUTE } from "@/config/siigo-map";
import { testOverride } from "../test-hooks";

// SIIGO_API_URL solo tiene efecto con NODE_ENV test/development (src/lib/test-hooks.ts); en producción se ignora.
const BASE = testOverride("SIIGO_API_URL", "https://api.siigo.com").replace(/\/+$/, "");
const RENEW_BEFORE_MS = 60 * 60_000; // renovar 1 h antes de vencer (el token dura 24 h)

/** Siigo respondió con un error HTTP (4xx/5xx). `message` es legible en español/inglés de Siigo. */
export class SiigoHttpError extends Error {
  constructor(public status: number, message: string, public body: unknown) {
    super(message);
  }
}
/** Timeout o fallo de red: NO se sabe si Siigo procesó la petición. */
export class SiigoNetworkError extends Error {}

type State = {
  token: string | null;
  expiresAt: number;
  inflight: Promise<string> | null;
  stamps: number[];
};
// En globalThis para sobrevivir a recargas en desarrollo
const g = globalThis as unknown as { __siigo?: State };
const st: State = (g.__siigo ??= { token: null, expiresAt: 0, inflight: null, stamps: [] });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function partnerId() {
  const p = process.env.SIIGO_PARTNER_ID;
  if (!p) throw new Error("Falta SIIGO_PARTNER_ID en .env.local");
  return p;
}

/** Límite de Siigo: 100 peticiones/minuto por empresa. Ventana deslizante de 60 s. */
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (st.stamps.length && now - st.stamps[0] > 60_000) st.stamps.shift();
    if (st.stamps.length < SIIGO_MAX_REQUESTS_PER_MINUTE) {
      st.stamps.push(now);
      return;
    }
    await sleep(60_000 - (now - st.stamps[0]) + 50);
  }
}

/** Peticiones a Siigo hechas en el último minuto (toda la app comparte esta ventana). La sincronización de clientes la mira para ceder el paso a la facturación. */
export function siigoRequestsLastMinute(): number {
  const now = Date.now();
  return st.stamps.filter((t) => now - t <= 60_000).length;
}

function readableError(body: unknown, status: number): string {
  const b = body as { Errors?: { Code?: string; Message?: string; Params?: string[] }[]; message?: string } | null;
  if (b?.Errors?.length) {
    return b.Errors.map((e) => `${e.Message ?? e.Code ?? "Error"}${e.Params?.length ? ` [${e.Params.join(", ")}]` : ""}`).join("; ");
  }
  return b?.message ?? `Siigo respondió ${status}`;
}

async function requestToken(): Promise<string> {
  const username = process.env.SIIGO_USERNAME;
  const access_key = process.env.SIIGO_ACCESS_KEY;
  if (!username || !access_key) throw new Error("Faltan SIIGO_USERNAME / SIIGO_ACCESS_KEY en .env.local");
  await throttle();
  let res: Response;
  try {
    res = await fetch(`${BASE}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Partner-Id": partnerId() },
      body: JSON.stringify({ username, access_key }),
      signal: AbortSignal.timeout(SIIGO_DEFAULT_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (e) {
    throw new SiigoNetworkError(`No se pudo conectar con Siigo (auth): ${e instanceof Error ? e.message : e}`);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.access_token) {
    throw new SiigoHttpError(res.status, `Autenticación con Siigo falló: ${readableError(body, res.status)}`, null);
  }
  st.token = body.access_token as string;
  // expires_in viene en segundos (86400 = 24 h)
  st.expiresAt = Date.now() + Number(body.expires_in ?? 86400) * 1000;
  return st.token;
}

async function getToken(force = false): Promise<string> {
  if (!force && st.token && Date.now() < st.expiresAt - RENEW_BEFORE_MS) return st.token;
  // Si varias peticiones piden token a la vez, comparten la misma solicitud
  st.inflight ??= requestToken().finally(() => {
    st.inflight = null;
  });
  return st.inflight;
}

type Opts = { body?: unknown; timeoutMs?: number; idempotencyKey?: string };

/** Llama a la API de Siigo. Reintenta solo en 401 (token) y 429 (límite), que nunca crean documentos. */
export async function siigo<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, opts: Opts = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = await getToken(attempt > 0 && attempt < 2);
    await throttle();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Partner-Id": partnerId(),
      "Content-Type": "application/json",
    };
    if (opts.idempotencyKey && method === "POST") headers["Idempotency-Key"] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? SIIGO_DEFAULT_TIMEOUT_MS),
        cache: "no-store",
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new SiigoNetworkError(
        timeout ? `Siigo no respondió a tiempo (${method} ${path})` : `Error de red con Siigo (${method} ${path}): ${e instanceof Error ? e.message : e}`
      );
    }

    if (res.status === 401 && attempt === 0) continue; // token vencido o revocado: pedir otro y repetir
    if (res.status === 429 && attempt < 3) {
      await sleep(20_000);
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new SiigoHttpError(res.status, readableError(body, res.status), body);
    return body as T;
  }
}

/** Prueba de conexión (para /admin/configuracion en la etapa 5). */
export async function siigoTestConnection() {
  await getToken(true);
  return { ok: true };
}
