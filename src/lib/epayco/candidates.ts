// Consulta a ePayco probando, EN ORDEN, cada referencia que se conozca de un pago: la larga (ref_payco, la única que documenta ePayco),
// el x_transaction_id y la corta (x_ref_payco) del webhook. PSE manda el webhook sin la referencia larga, por eso se prueban las otras.
// Todo pasa por processPayment: monto, firma, invoice, x_extra1, modo de prueba, reclamo atómico del ref y UNA sola factura.
// Quien resuelve primero gana; se anota cuál (payment_attempts.ref_used) y se deja en el log.
import type { RefCandidate, RefKind } from "./attempts";
import { processPayment, type PaymentCheckSource, type PaymentResult } from "./process";

export type CandidateRun = PaymentResult & {
  /** con qué tipo de referencia ePayco devolvió la transacción (null = con ninguna) */
  used: RefKind | null;
  /** cada intento, en orden */
  tried: { kind: RefKind; resolved: boolean; why?: string }[];
  /** alguna consulta falló por algo pasajero (red / error HTTP de ePayco): conviene reintentar luego */
  transient: boolean;
};

export async function verifyByCandidates(saleId: string, cands: RefCandidate[], source: PaymentCheckSource): Promise<CandidateRun | null> {
  if (!cands.length) return null;
  const tried: CandidateRun["tried"] = [];
  let last: PaymentResult | null = null;
  let transient = false;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    const r = await processPayment(saleId, c.ref, source, { kind: c.kind });
    last = r;
    if (r.outcome !== "no_verificado") {
      tried.push({ kind: c.kind, resolved: true });
      return { ...r, used: c.kind, tried, transient };
    }
    tried.push({ kind: c.kind, resolved: false, why: r.unresolvedKind ?? "no_resuelto" });
    if (r.unresolvedKind === "network" || r.unresolvedKind === "http") transient = true;
  }
  return { ...last!, used: null, tried, transient };
}

/** Texto corto de lo probado, para el log: "larga: no reconocida · transaction_id: no reconocida" */
export const triedText = (t: CandidateRun["tried"]) =>
  t.map((x) => `${x.kind}: ${x.resolved ? "reconocida" : x.why === "notfound" ? "no reconocida por ePayco" : `no se pudo consultar (${x.why})`}`).join(" · ");
