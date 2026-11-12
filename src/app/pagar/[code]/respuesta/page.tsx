import type { Metadata } from "next";
import { getEpaycoConfig } from "@/lib/epayco/config";
import { findPublicSale, publicMessage } from "@/lib/pay-link";
import LinkNotFound from "../LinkNotFound";
import PagarClient from "../PagarClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Resultado del pago — FECP", robots: { index: false, follow: false } };

/**
 * PÚBLICA (sin sesión): a esta página vuelve ePayco al cliente (?ref_payco=...). OJO: llegar aquí NO significa que pagó.
 * La pantalla manda el ref_payco al servidor, que lo verifica con ePayco; solo entonces el estado cambia a "pagado".
 */
export default async function RespuestaPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const s = await findPublicSale(code);
  if (!s) return <LinkNotFound />;
  return (
    <PagarClient
      code={code}
      mode="respuesta"
      initial={{
        local_number: s.local_number, total: s.total, status: s.status, invoice_name: s.invoice_name, can_pay: s.can_pay,
        message: s.status === "esperando_pago" ? "Verificando su pago…" : publicMessage(s.status), test: getEpaycoConfig().testMode, expires_at: s.expires_at,
      }}
    />
  );
}
