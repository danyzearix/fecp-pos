// Verificación de un pago de ePayco contra NUESTRA venta. Función pura: decide, no escribe nada.
// Regla: ante cualquier duda → 'review' (nunca se factura). Solo 'approved' lleva a facturar.
import { expectedSignature, signatureMatches, EpaycoError, type NormalizedTx } from "./adapter";

export type Verdict =
  | { kind: "approved" }
  | { kind: "pending"; reason: string } // aún no es definitivo: no se factura, tampoco se da por fallido
  | { kind: "rejected"; reason: string; /** el cliente canceló o abandonó (no fue el banco) */ cancelled: boolean } // definitivo: no hubo pago
  | { kind: "review"; reason: string }; // algo no coincide o no se pudo confirmar: lo decide un admin

const REJECT_TEXT: Record<number, string> = {
  2: "Pago rechazado por el banco o la entidad",
  4: "La transacción falló",
  9: "El plazo para pagar venció",
  10: "El pago fue abandonado antes de terminar",
  11: "El pago fue cancelado",
};
const EXPECTED_TEXT: Record<number, string> = { 1: "aceptada", 2: "rechazada", 3: "pendiente", 4: "fallida" };

export function judgeTransaction(
  tx: NormalizedTx,
  sale: { local_number: string; total: number; /** referencias válidas: el número de compra y las de cada intento de pago */ invoices?: string[] },
  opts: { saleId: string; testMode: boolean }
): Verdict {
  // 1) Identidad y montos: si algo no coincide, es "por revisar" sin importar el estado reportado.
  // (No se compara x_ref_payco con el ref consultado: ePayco consulta por el id LARGO y responde con el número CORTO.)
  if (tx.extra1 && tx.extra1 !== opts.saleId) {
    return { kind: "review", reason: "x_extra1 de ePayco no corresponde a esta venta" };
  }
  if (tx.invoice !== sale.local_number && !(sale.invoices ?? []).includes(tx.invoice)) {
    return { kind: "review", reason: `El invoice de ePayco (${tx.invoice}) no corresponde a esta venta (${sale.local_number})` };
  }
  if (Math.abs(tx.amount - sale.total) >= 0.005) {
    return { kind: "review", reason: `El monto de ePayco (${tx.amount}) no coincide con el total de la venta (${sale.total})` };
  }
  if (tx.currency !== "COP") return { kind: "review", reason: `Moneda inesperada: ${tx.currency}` };

  // 2) Modo de pruebas coherente con EPAYCO_TEST_MODE
  if (tx.testRequest === null) return { kind: "review", reason: "La respuesta no trae x_test_request: no se puede confirmar el modo (prueba/real)" };
  if (tx.testRequest !== opts.testMode) {
    return {
      kind: "review",
      reason: tx.testRequest ? "Es una transacción de PRUEBA pero el sistema está en modo real" : "Es una transacción REAL pero el sistema está en modo de prueba",
    };
  }

  // 3) Firma, si la respuesta la trae
  if (tx.signature) {
    if (!tx.transactionId) return { kind: "review", reason: "Trae x_signature pero no x_transaction_id: no se puede validar la firma" };
    try {
      const exp = expectedSignature({ ref: tx.refPayco, transactionId: tx.transactionId, amountRaw: tx.amountRaw, currency: tx.currency });
      if (!signatureMatches(tx.signature, exp)) return { kind: "review", reason: "La firma (x_signature) no es válida" };
    } catch (e) {
      return { kind: "review", reason: e instanceof EpaycoError ? e.message : "No se pudo validar la firma" };
    }
  }

  // 4) Estado
  if (tx.response && EXPECTED_TEXT[tx.codResponse] && tx.response.toLowerCase() !== EXPECTED_TEXT[tx.codResponse]) {
    return { kind: "review", reason: `Código ${tx.codResponse} no coincide con el texto "${tx.response}"` };
  }
  switch (tx.codResponse) {
    case 1:
      return { kind: "approved" };
    case 3:
    case 8:
      return { kind: "pending", reason: "Pago pendiente de confirmación" };
    case 2:
    case 4:
    case 9:
    case 10:
    case 11:
      return {
        kind: "rejected",
        reason: REJECT_TEXT[tx.codResponse],
        // 10 abandonada y 11 cancelada: lo hizo el cliente. También si el texto lo dice (la documentación de ePayco no publica los números)
        cancelled: tx.codResponse === 10 || tx.codResponse === 11 || /cancel|abandon/i.test(tx.response ?? ""),
      };
    default:
      // 6 reversada, 7 retenida u otro código: puede haber dinero en movimiento → un admin revisa
      return { kind: "review", reason: `Estado de ePayco que requiere revisión (código ${tx.codResponse})` };
  }
}
