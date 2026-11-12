import { NextResponse } from "next/server";
import { guardApi } from "@/lib/auth";
import { createKioskPayment, sourceForRole } from "@/lib/kiosk";
import { browserOrigin } from "@/lib/origin";

export const maxDuration = 60;

/**
 * Crea un cobro electrónico. Lo usan el kiosco (rol cliente → venta 'kiosco') y la caja (cajero/admin → venta 'caja').
 * Acepta productos y cantidades; el total lo calcula el servidor.
 */
export async function POST(req: Request) {
  const g = await guardApi(req);
  if (!g.ok) return g.res;
  const body = await req.json().catch(() => null);
  const r = await createKioskPayment({ userId: g.user.uid, source: sourceForRole(g.user.role), body, origin: browserOrigin(req) });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({
    sale_id: r.saleId,
    local_number: r.localNumber,
    session_id: r.sessionId, // lo usa el navegador para abrir el checkout de ePayco (no es una llave)
    total: r.total,
    expires_at: r.expiresAt,
    test: r.testMode,
    // Solo para la caja: el kiosco no muestra el enlace (el pay_token completo es el "código" de quien paga desde el celular)
    pay_url: sourceForRole(g.user.role) === "caja" ? r.payUrl : null,
  });
}
