import type { Metadata } from "next";
import { getEpaycoConfig } from "@/lib/epayco/config";
import { findPublicSale, publicMessage } from "@/lib/pay-link";
import LinkNotFound from "./LinkNotFound";
import PagarClient from "./PagarClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Pagar compra — FECP", robots: { index: false, follow: false } };

/** PÚBLICA (sin sesión): enlace de pago de una compra. El código (pay_token) es secreto; no se lista en ningún lado. */
export default async function PagarPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const s = await findPublicSale(code);
  if (!s) return <LinkNotFound />;
  return (
    <PagarClient
      code={code}
      mode="pagar"
      initial={{
        local_number: s.local_number, total: s.total, status: s.status, invoice_name: s.invoice_name, can_pay: s.can_pay,
        message: publicMessage(s.status), test: getEpaycoConfig().testMode, expires_at: s.expires_at,
      }}
    />
  );
}
