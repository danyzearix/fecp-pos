import { getEpaycoConfig } from "@/lib/epayco/config";
import { processReturn } from "@/lib/epayco/return";
import { findPublicSale, publicInProcess, publicMessageFor } from "@/lib/pay-link";
import LinkNotFound from "./LinkNotFound";
import PagarClient from "./PagarClient";

/**
 * Página a la que ePayco devuelve al cliente (/pagar/<código>/retorno y la antigua /respuesta). El SERVIDOR toma el ref_payco de la URL,
 * lo guarda en el intento y lo verifica con ePayco ANTES de mostrar nada; luego la pantalla sigue consultando el estado sola.
 */
export default async function ReturnView({ code, searchParams }: { code: string; searchParams: Record<string, string | string[] | undefined> }) {
  const s0 = await findPublicSale(code);
  if (!s0) return <LinkNotFound />;
  await processReturn(s0, code, searchParams);
  const s = (await findPublicSale(code)) ?? s0;
  return (
    <PagarClient
      code={code}
      mode="retorno"
      initial={{
        local_number: s.local_number, total: s.total, status: s.status, payment_status: s.payment_status, invoice_name: s.invoice_name, can_pay: s.can_pay,
        channel_changed: s.channel_changed, attempt_status: s.attempt_status, source: s.source, in_process: publicInProcess(s),
        message: publicMessageFor(s), test: getEpaycoConfig().testMode, expires_at: s.expires_at,
      }}
    />
  );
}
