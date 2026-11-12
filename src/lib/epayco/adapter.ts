// ADAPTADOR de ePayco: el ÚNICO archivo que habla con la API de ePayco. Si ePayco cambia un endpoint o un formato,
// se arregla aquí y nada más. Nunca registra llaves ni tokens.
//
// Formato VERIFICADO el 2026-11-11 con un pago real de prueba (checkout nuevo / Davipay):
//  - GET secure.epayco.co/validation/v1/reference/{ref_payco} funciona con el ref_payco LARGO (24 hex, el que llega en
//    ?ref_payco=...). Con el número corto ("Referencia Davipay", p. ej. 393406419) responde "Error de datos o conexión".
//  - Respuesta: { success, data: { x_ref_payco (número corto), x_id_invoice, x_amount (número), x_currency_code,
//    x_cod_response (número), x_response, x_test_request ("TRUE"/"FALSE"), x_signature, x_extra1, ... } }.
//  - La firma SHA-256(P_CUST_ID_CLIENTE^P_KEY^x_ref_payco^x_transaction_id^x_amount^x_currency_code) coincidió.
// Si falta un campo imprescindible o el formato cambia, se lanza EpaycoError('format'): NO se factura ("por revisar").
import crypto from "node:crypto";
import { getEpaycoConfig } from "./config";

export class EpaycoError extends Error {
  constructor(public kind: "network" | "http" | "format" | "auth" | "config", message: string) {
    super(message);
  }
}

/** Transacción normalizada (lo único que el resto del sistema conoce de ePayco) */
export type NormalizedTx = {
  /** x_ref_payco: número CORTO (p. ej. 393408143). OJO: NO es el id largo con el que se consulta */
  refPayco: string;
  transactionId: string | null;
  invoice: string; // x_id_invoice (nuestro número de venta)
  amountRaw: string; // tal cual lo devolvió ePayco (se usa para la firma)
  amount: number;
  currency: string;
  codResponse: number; // 1 aceptada, 2 rechazada, 3 pendiente, 4 fallida...
  response: string | null; // "Aceptada" | "Rechazada" | ...
  testRequest: boolean | null;
  signature: string | null;
  approvalCode: string | null;
  franchise: string | null;
  /** x_extra1: enviamos aquí el id (UUID) de nuestra venta al crear la sesión */
  extra1: string | null;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

/** Convierte la respuesta de ePayco (con o sin envoltorio {success, data}) en NormalizedTx, o lanza EpaycoError('format'). */
export function normalizeTransaction(body: unknown): NormalizedTx {
  if (!isObj(body)) throw new EpaycoError("format", "La respuesta de ePayco no es un objeto JSON");
  if (body.success === false) throw new EpaycoError("http", `ePayco respondió success=false${str(body.text_response) ? `: ${str(body.text_response)}` : ""}`);
  const d = isObj(body.data) ? body.data : body;

  const ref = str(d.x_ref_payco) ?? str(d.ref_payco);
  const invoice = str(d.x_id_invoice) ?? str(d.x_id_factura);
  const amountRaw = str(d.x_amount);
  const currency = str(d.x_currency_code);
  const codRaw = d.x_cod_response ?? d.x_cod_transaction_state ?? d.x_cod_respuesta;
  const cod = codRaw === undefined || codRaw === null || codRaw === "" ? NaN : Number(codRaw);

  const missing = [
    !ref && "x_ref_payco",
    !invoice && "x_id_invoice",
    !amountRaw && "x_amount",
    !currency && "x_currency_code",
    !Number.isInteger(cod) && "x_cod_response",
  ].filter(Boolean);
  if (missing.length) throw new EpaycoError("format", `Respuesta de ePayco sin campos obligatorios: ${missing.join(", ")}`);

  const amount = Number(String(amountRaw).replace(/,/g, ""));
  if (!Number.isFinite(amount)) throw new EpaycoError("format", "x_amount no es un número");

  const t = d.x_test_request;
  const testRequest = typeof t === "boolean" ? t : typeof t === "string" ? (t.toLowerCase() === "true" ? true : t.toLowerCase() === "false" ? false : null) : null;

  return {
    refPayco: ref!,
    transactionId: str(d.x_transaction_id),
    invoice: invoice!,
    amountRaw: amountRaw!,
    amount,
    currency: currency!.toUpperCase(),
    codResponse: cod,
    response: str(d.x_response),
    testRequest,
    signature: str(d.x_signature),
    approvalCode: str(d.x_approval_code),
    franchise: str(d.x_franchise),
    extra1: str(d.x_extra1),
  };
}

// ---------------------------------------------------------------------------
// Firma: SHA-256( p_cust_id_cliente ^ p_key ^ x_ref_payco ^ x_transaction_id ^ x_amount ^ x_currency_code )
// ---------------------------------------------------------------------------
export function expectedSignature(parts: { ref: string; transactionId: string; amountRaw: string; currency: string }): string {
  const cfg = getEpaycoConfig();
  if (!cfg.customerId || !cfg.pKey) throw new EpaycoError("config", "Faltan EPAYCO_P_CUST_ID_CLIENTE / EPAYCO_P_KEY");
  const s = [cfg.customerId, cfg.pKey, parts.ref, parts.transactionId, parts.amountRaw, parts.currency].join("^");
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Comparación en tiempo constante */
export function signatureMatches(got: string, expected: string): boolean {
  const a = Buffer.from(got.trim().toLowerCase());
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function http(url: string, init: RequestInit): Promise<{ status: number; json: unknown }> {
  const cfg = getEpaycoConfig();
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs), cache: "no-store", redirect: "manual" });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new EpaycoError("network", timeout ? "ePayco no respondió a tiempo" : `No se pudo conectar con ePayco: ${e instanceof Error ? e.message : e}`);
  }
  const text = await res.text().catch(() => "");
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    if (res.ok) throw new EpaycoError("format", "ePayco devolvió una respuesta que no es JSON");
  }
  return { status: res.status, json };
}

// Token de APIFY en memoria (se renueva al vencer o si ePayco responde 401)
const g = globalThis as unknown as { __epaycoToken?: { token: string; at: number } };
const TOKEN_TTL_MS = 10 * 60_000; // la vigencia no está documentada (parece ~20 min): se renueva antes

async function apifyToken(force = false): Promise<string> {
  const cfg = getEpaycoConfig();
  if (!cfg.publicKey || !cfg.privateKey) throw new EpaycoError("config", "Faltan EPAYCO_PUBLIC_KEY / EPAYCO_PRIVATE_KEY");
  if (!force && g.__epaycoToken && Date.now() - g.__epaycoToken.at < TOKEN_TTL_MS) return g.__epaycoToken.token;
  const basic = Buffer.from(`${cfg.publicKey}:${cfg.privateKey}`).toString("base64");
  const { status, json } = await http(`${cfg.apifyUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` },
  });
  const token = isObj(json) ? str(json.token) : null;
  if (status < 200 || status >= 300 || !token) throw new EpaycoError("auth", `ePayco rechazó el login de APIFY (HTTP ${status})`);
  g.__epaycoToken = { token, at: Date.now() };
  return token;
}

/** Crea la sesión de checkout. Devuelve el sessionId que el navegador usa para abrir el checkout. */
export async function createCheckoutSession(input: {
  name: string;
  amount: number;
  description: string;
  invoice: string;
  response?: string;
  confirmation?: string;
  extra1?: string;
}): Promise<{ sessionId: string }> {
  const cfg = getEpaycoConfig();
  const body: Obj = {
    checkout_version: "2",
    name: input.name,
    currency: "COP",
    amount: input.amount,
    description: input.description,
    invoice: input.invoice,
    country: "CO",
    lang: "ES",
  };
  if (input.response) body.response = input.response;
  if (input.confirmation) body.confirmation = input.confirmation;
  if (input.extra1) body.extras = { extra1: input.extra1 };

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await apifyToken(attempt > 0);
    const { status, json } = await http(`${cfg.apifyUrl}/payment/session/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (status === 401 && attempt === 0) continue; // token vencido: pedir otro
    const data = isObj(json) && isObj(json.data) ? json.data : null;
    const sessionId = data ? str(data.sessionId) : null;
    if (status < 200 || status >= 300 || !sessionId) {
      const t = isObj(json) ? str(json.textResponse) ?? str(json.text_response) : null;
      // ePayco responde HTTP 200 con success=false y el detalle en data.errors[].errorMessage
      const errs = isObj(json) && isObj(json.data) && Array.isArray(json.data.errors)
        ? json.data.errors.map((x) => (isObj(x) ? str(x.errorMessage) : null)).filter(Boolean).join(" | ")
        : "";
      throw new EpaycoError("http", `ePayco no creó la sesión (HTTP ${status})${t ? `: ${t}` : ""}${errs ? ` — ${errs}` : ""}`);
    }
    return { sessionId };
  }
  throw new EpaycoError("auth", "ePayco rechazó el token de APIFY");
}

/** Consulta de la transacción por ref_payco (servidor a servidor). NUNCA se usan datos que mande el navegador. */
export async function fetchTransaction(refPayco: string): Promise<NormalizedTx> {
  const cfg = getEpaycoConfig();
  const { status, json } = await http(`${cfg.validationUrl}/${encodeURIComponent(refPayco)}`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (status < 200 || status >= 300) throw new EpaycoError("http", `ePayco respondió HTTP ${status} al consultar la transacción`);
  return normalizeTransaction(json);
}
