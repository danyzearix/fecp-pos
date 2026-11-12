// Crea la sesión de cobro en ePayco para UNA venta ya guardada. Lo comparten el kiosco, la caja y la página pública /pagar.
// El monto, la factura y el total salen de NUESTRA base de datos; la URL de regreso la decide quien llama.
import { writeLog } from "../log";
import { round2 } from "../money";
import { getPosConfig } from "../config";
import { createCheckoutSession, EpaycoError } from "./adapter";
import { getEpaycoConfig } from "./config";

export async function createSaleSession(p: {
  saleId: string;
  localNumber: string;
  total: number;
  /** a dónde vuelve el NAVEGADOR del cliente al terminar (ePayco agrega ?ref_payco=...) */
  wantedUrl: string;
  userId?: number | null;
  /** texto para los logs: "la caja", "el kiosco", "la página pública" */
  where: string;
}): Promise<{ sessionId: string; responseUrl: string | null }> {
  const cfg = getEpaycoConfig();
  const base = {
    name: getPosConfig().negocio.nombre || "FECP",
    amount: round2(p.total),
    description: `Compra ${p.localNumber}`,
    invoice: p.localNumber,
    confirmation: cfg.confirmationUrl || undefined, // webhook: solo en modo con dominio público
    extra1: p.saleId,
  };
  // Sin URL de respuesta, ePayco manda al cliente a su propia página (davipay.com) al cerrar. Con ella, el navegador
  // vuelve a nuestra pantalla con ?ref_payco=... y se retoma la venta. Si ePayco rechazara la URL, se reintenta sin ella.
  // ePayco rechaza "localhost" ("property Response is not a valid URL") pero acepta IPs (127.0.0.1, 192.168.x.x) y dominios.
  const host = new URL(p.wantedUrl).hostname;
  if (host === "localhost" || host.endsWith(".localhost")) {
    await writeLog("pago", `Cobro sin URL de respuesta: ePayco no acepta "${host}". Abra ${p.where} en http://127.0.0.1 (no localhost) para que el cliente vuelva solo a la pantalla.`, { level: "warn", userId: p.userId });
    return { ...(await createCheckoutSession(base)), responseUrl: null };
  }
  try {
    const { sessionId } = await createCheckoutSession({ ...base, response: p.wantedUrl });
    return { sessionId, responseUrl: p.wantedUrl };
  } catch (e) {
    if (!(e instanceof EpaycoError) || e.kind !== "http") throw e;
    await writeLog("pago", `ePayco rechazó la URL de respuesta (${p.wantedUrl}); se crea el cobro sin ella: ${e.message}`, { level: "warn", userId: p.userId });
    return { ...(await createCheckoutSession(base)), responseUrl: null };
  }
}
