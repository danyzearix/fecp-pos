import { NextResponse } from "next/server";
import { getEpaycoConfig } from "@/lib/epayco/config";
import { findPublicSale, publicMessageFor } from "@/lib/pay-link";
import { rateLimited } from "@/lib/rate-limit";

/** PÚBLICO (sin sesión). Estado de una venta por su código de pago. Solo lee nuestra base de datos. */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  if (rateLimited(`pagar:estado:${code.slice(0, 12)}`, 120, 60_000)) return NextResponse.json({ error: "Demasiadas consultas" }, { status: 429 });
  const s = await findPublicSale(code);
  if (!s) return NextResponse.json({ error: "Enlace no válido" }, { status: 404 });
  return NextResponse.json(
    {
      local_number: s.local_number, total: s.total, status: s.status, payment_status: s.payment_status, invoice_name: s.invoice_name,
      expires_at: s.expires_at, can_pay: s.can_pay, channel_changed: s.channel_changed, test: getEpaycoConfig().testMode, message: publicMessageFor(s),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
