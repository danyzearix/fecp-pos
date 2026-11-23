import { testOverride } from "../test-hooks";

// Configuración de ePayco (solo servidor). NUNCA se envían estas llaves al navegador ni se escriben en logs.

export type EpaycoConfig = {
  publicKey: string; // PUBLIC_KEY de APIFY
  privateKey: string; // PRIVATE_KEY de APIFY
  customerId: string; // P_CUST_ID_CLIENTE (firma del webhook)
  pKey: string; // P_KEY (firma del webhook)
  testMode: boolean; // EPAYCO_TEST_MODE
  /** Vacío = modo local (sin webhook ni QR de pago en la caja). Las páginas públicas /pagar/<código> están SIEMPRE activas. */
  publicBaseUrl: string;
  confirmationUrl: string;
  responseUrl: string;
  apifyUrl: string;
  validationUrl: string;
  timeoutMs: number;
  /** minutos que dura un cobro antes de pasar a pago_fallido */
  expiresMinutes: number;
  /** cada cuántos segundos el SERVIDOR consulta a ePayco por su cuenta los cobros que siguen esperando (0 = apagado). EPAYCO_POLL_SECONDS, por defecto 20. */
  pollSeconds: number;
};

const strip = (s: string | undefined) => (s ?? "").trim().replace(/\/+$/, "");

export function getEpaycoConfig(): EpaycoConfig {
  const e = process.env;
  const publicBaseUrl = strip(e.APP_PUBLIC_URL);
  return {
    publicKey: (e.EPAYCO_PUBLIC_KEY ?? "").trim(),
    privateKey: (e.EPAYCO_PRIVATE_KEY ?? "").trim(),
    customerId: (e.EPAYCO_P_CUST_ID_CLIENTE ?? "").trim(),
    pKey: (e.EPAYCO_P_KEY ?? "").trim(),
    testMode: e.EPAYCO_TEST_MODE === "true",
    publicBaseUrl,
    confirmationUrl: strip(e.EPAYCO_CONFIRMATION_URL) || (publicBaseUrl ? `${publicBaseUrl}/api/epayco/confirmacion` : ""),
    // URL a la que ePayco devuelve el NAVEGADOR del cliente al terminar (?ref_payco=...). Si no se define, el kiosco usa
    // su propia pantalla (/kiosco) del mismo origen: la redirección la hace el navegador, así que funciona en localhost.
    responseUrl: strip(e.EPAYCO_RESPONSE_URL),
    // EPAYCO_APIFY_URL / EPAYCO_VALIDATION_URL / EPAYCO_TIMEOUT_MS: solo tienen efecto con NODE_ENV test/development
    // (src/lib/test-hooks.ts). En producción siempre se usan las URLs oficiales.
    apifyUrl: strip(testOverride("EPAYCO_APIFY_URL", "https://apify.epayco.co")),
    validationUrl: strip(testOverride("EPAYCO_VALIDATION_URL", "https://secure.epayco.co/validation/v1/reference")),
    timeoutMs: Number(testOverride("EPAYCO_TIMEOUT_MS", "15000")) || 15_000,
    expiresMinutes: 10,
    pollSeconds: (() => {
      const raw = (e.EPAYCO_POLL_SECONDS ?? "").trim();
      if (!raw) return 20;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? Math.max(n === 0 ? 0 : 5, Math.floor(n)) : 20;
    })(),
  };
}

/** ¿Está activo el modo con dominio público (QR al celular, /pagar, página de respuesta, webhook)? */
export const publicModeEnabled = () => getEpaycoConfig().publicBaseUrl !== "";

/** Variables obligatorias que faltan (nombres, nunca valores). */
export function epaycoMissingEnv(): string[] {
  const e = process.env;
  const need = ["EPAYCO_PUBLIC_KEY", "EPAYCO_PRIVATE_KEY", "EPAYCO_P_CUST_ID_CLIENTE", "EPAYCO_P_KEY"];
  return need.filter((k) => !(e[k] ?? "").trim());
}
