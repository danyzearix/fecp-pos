// Canal de pago de un cobro electrónico. Un cobro tiene UN solo canal abierto a la vez:
//   - 'qr':       el cliente paga en SU celular con el enlace /pagar/<código>. No se abre el checkout en el equipo.
//   - 'pantalla': checkout onpage de ePayco en el equipo (caja o kiosco). El enlace /pagar queda cerrado.
// El canal vive en la base de datos (sales.pay_channel) y lo hacen cumplir los endpoints, no la pantalla.
// El cambio de canal y la apertura de cada intento viven en attempts.ts (openAttempt).
// Red de seguridad: si aun así llegaran dos pagos aprobados (p. ej. alguien ya estaba pagando por el canal anterior),
// el segundo NO se factura: queda como "duplicado, reembolsar" (ver process.ts).
import { getEpaycoConfig } from "./config";

export type PayChannel = "qr" | "pantalla";
export const isPayChannel = (v: unknown): v is PayChannel => v === "qr" || v === "pantalla";

/** ¿Existe el canal QR? Solo con dominio público (APP_PUBLIC_URL): un celular no puede abrir 127.0.0.1 del equipo. */
export const qrAvailable = () => !!getEpaycoConfig().publicBaseUrl;

/** Canal inicial: la caja empieza por QR y el kiosco en pantalla. Sin dominio público solo existe "pantalla". */
export function initialChannel(source: "caja" | "kiosco", requested: unknown): PayChannel {
  if (!qrAvailable()) return "pantalla";
  if (isPayChannel(requested)) return requested;
  return source === "caja" ? "qr" : "pantalla";
}

export const payUrlFor = (payToken: string | null) => {
  const base = getEpaycoConfig().publicBaseUrl;
  return base && payToken ? `${base}/pagar/${payToken}` : null;
};
