// Canal de pago de un cobro electrónico. Un cobro tiene UN solo canal abierto a la vez:
//   - 'qr':       el cliente paga en SU celular con el enlace /pagar/<código>. No se abre el checkout en el equipo.
//   - 'pantalla': checkout onpage de ePayco en el equipo (caja o kiosco). El enlace /pagar queda cerrado.
// El canal vive en la base de datos (sales.pay_channel) y lo hacen cumplir los endpoints, no la pantalla.
// Red de seguridad: si aun así llegaran dos pagos aprobados (p. ej. alguien ya estaba pagando por el canal anterior),
// el segundo NO se factura: queda como "duplicado, reembolsar" (ver process.ts).
import { pool } from "../db";
import { writeLog } from "../log";
import { getEpaycoConfig } from "./config";
import { createSaleSession } from "./session";

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

export type ChannelChange =
  | { ok: true; channel: PayChannel; sessionId: string | null; payUrl: string | null }
  | { ok: false; status: number; error: string };

/**
 * Cambia el canal de un cobro que sigue 'esperando_pago'. Al pasar a 'pantalla' se crea una sesión NUEVA de ePayco (la del
 * equipo); al pasar a 'qr' el enlace vuelve a servir. El cambio queda en los logs.
 */
export async function changeChannel(p: {
  saleId: string;
  to: PayChannel;
  userId: number;
  /** a dónde vuelve el navegador del equipo tras pagar en pantalla (p. ej. https://pos.fecp.me/caja) */
  responseUrl: string;
  where: string;
}): Promise<ChannelChange> {
  if (p.to === "qr" && !qrAvailable()) return { ok: false, status: 409, error: "El pago con QR no está disponible (falta el dominio público)." };

  const c = await pool.connect();
  try {
    const cur = (
      await c.query<{ local_number: string; total: number; status: string; pay_channel: string | null; pay_token: string | null; payment_expires_at: Date | null }>(
        "SELECT local_number, total::float8 AS total, status, pay_channel, pay_token, payment_expires_at FROM sales WHERE id = $1",
        [p.saleId]
      )
    ).rows[0];
    if (!cur) return { ok: false, status: 404, error: "Venta no encontrada" };
    if (cur.status !== "esperando_pago" || !cur.payment_expires_at || cur.payment_expires_at.getTime() < Date.now()) {
      return { ok: false, status: 409, error: "Este cobro ya no está esperando el pago." };
    }
    const from = cur.pay_channel ?? "pantalla";

    // Pantalla: hace falta una sesión de ePayco NUEVA para el equipo (la del celular, si la hubo, no se reutiliza)
    let sessionId: string | null = null;
    if (p.to === "pantalla") {
      const s = await createSaleSession({ saleId: p.saleId, localNumber: cur.local_number, total: cur.total, wantedUrl: p.responseUrl, userId: p.userId, where: p.where });
      sessionId = s.sessionId;
    }

    // Cambio atómico: solo si el cobro SIGUE esperando (pudo pagarse mientras tanto)
    const upd = await c.query(
      `UPDATE sales SET pay_channel = $2, pay_channel_changed_at = now(), epayco_session_id = COALESCE($3, epayco_session_id)
        WHERE id = $1 AND status = 'esperando_pago'`,
      [p.saleId, p.to, sessionId]
    );
    if (!upd.rowCount) return { ok: false, status: 409, error: "Este cobro ya no está esperando el pago." };

    if (from !== p.to) {
      await writeLog("pago", `Canal de pago de ${cur.local_number} cambiado: ${from === "qr" ? "QR (celular)" : "en pantalla"} → ${p.to === "qr" ? "QR (celular)" : "en pantalla"}`, {
        userId: p.userId,
        detail: { sale_id: p.saleId, from, to: p.to, session_id: sessionId },
      });
    }
    return { ok: true, channel: p.to, sessionId, payUrl: p.to === "qr" ? payUrlFor(cur.pay_token) : null };
  } finally {
    c.release();
  }
}
