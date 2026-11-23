import type { Metadata } from "next";
import { getEpaycoConfig } from "@/lib/epayco/config";
import { markQrOpened } from "@/lib/epayco/attempts";
import { findPublicSale, publicMessageFor } from "@/lib/pay-link";
import LinkNotFound from "./LinkNotFound";
import PagarClient from "./PagarClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pagar compra", robots: { index: false, follow: false } };

/** PÚBLICA (sin sesión): enlace de pago de una compra. El código (pay_token) es secreto; no se lista en ningún lado. */
export default async function PagarPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const s = await findPublicSale(code);
  if (!s) return <LinkNotFound />;
  // Se registra que el enlace se abrió en un celular: desde aquí el cobro ya no puede cambiarse de canal
  if (s.status === "esperando_pago") await markQrOpened(s.id).catch(() => {});
  return (
    <PagarClient
      code={code}
      mode="pagar"
      initial={{
        local_number: s.local_number, total: s.total, status: s.status, invoice_name: s.invoice_name, can_pay: s.can_pay, channel_changed: s.channel_changed, attempt_status: s.attempt_status,
        message: publicMessageFor(s), test: getEpaycoConfig().testMode, expires_at: s.expires_at,
      }}
    />
  );
}
