// Medios de pago del POS (navegador y servidor). El id interno NO cambia aunque cambie la etiqueta,
// porque se guarda en sale_payments.method / sales.payment_method y se mapea a Siigo en src/config/siigo-map.ts.
//
// Medios que se pueden ELEGIR hoy en la caja (una venta puede combinar varios, ver src/lib/payment-lines.ts):
//   Efectivo · Tarjeta · Transferencia · Crédito FECP · Pago electrónico (ePayco)
// Medios HISTÓRICOS (ya no se ofrecen, pero las ventas viejas conservan su etiqueta original):
//   Tarjeta débito · Tarjeta crédito (antes eran dos medios; ambos iban al id 1669 de Siigo)
// sales.payment_method = el medio de la única línea, o "mixto" si la venta tiene varias líneas de pago.

export const PAYMENT_METHODS = [
  { id: "efectivo", label: "Efectivo" },
  { id: "tarjeta", label: "Tarjeta" },
  { id: "transferencia", label: "Transferencia (Nequi/Bancolombia/otra)" },
  { id: "credito_fecp", label: "Crédito FECP" },
  // Solo lo asigna el servidor a las ventas del kiosco / cobro electrónico. Nunca se combina con otro medio.
  { id: "epayco", label: "Pago electrónico (PSE, tarjetas, QR)" },
] as const;

/** Medios que ya no se ofrecen pero existen en ventas históricas (y en la cola local de versiones anteriores). */
export const LEGACY_PAYMENT_METHODS = [
  { id: "tarjeta_debito", label: "Tarjeta débito" },
  { id: "tarjeta_credito", label: "Tarjeta crédito" },
] as const;

/** Medio de UNA línea de pago */
export type LineMethod = (typeof PAYMENT_METHODS)[number]["id"] | (typeof LEGACY_PAYMENT_METHODS)[number]["id"];
/** Valor de sales.payment_method: el medio de la línea, o "mixto" */
export type PaymentMethod = LineMethod | "mixto";

/** Medios que puede elegir un cajero en el cobro (el pago electrónico tiene su propio flujo) */
export const CASHIER_PAYMENT_METHODS = PAYMENT_METHODS.filter((m) => m.id !== "epayco");

const LABELS: Record<string, string> = {
  ...Object.fromEntries(PAYMENT_METHODS.map((m) => [m.id, m.label])),
  ...Object.fromEntries(LEGACY_PAYMENT_METHODS.map((m) => [m.id, m.label])),
  mixto: "Mixto",
};
export const paymentLabel = (id: string) => LABELS[id] ?? id;

/** Etiqueta corta (sin el texto entre paréntesis), para listas compactas y la tirilla */
export const paymentShortLabel = (id: string) =>
  id === "transferencia" ? "Transferencia" : id === "epayco" ? "Pago electrónico" : paymentLabel(id);

/** Todo medio que pasa por datáfono o cuenta bancaria exige referencia del comprobante (en ePayco: el ref_payco verificado). */
export const requiresReference = (id: string) => id !== "efectivo" && id !== "credito_fecp" && id !== "mixto";

/** ¿Es una tarjeta (la actual o las dos históricas)? */
export const isCardMethod = (id: string) => id === "tarjeta" || id === "tarjeta_debito" || id === "tarjeta_credito";

/** Crédito FECP: no es dinero recaudado (queda por cobrar en Siigo) */
export const isCreditMethod = (id: string) => id === "credito_fecp";

/*
 * Pago electrónico (ePayco) — autoservicio, etapa 5B. Resumen de las reglas (el detalle está en src/lib/epayco/):
 *  - Una venta del kiosco nace en 'esperando_pago'. NO se factura hasta que el SERVIDOR verifique el pago
 *    con ePayco (consulta del ref_payco o webhook firmado); nunca por lo que diga el navegador.
 *  - Si el pago falla, vence o algo no coincide, NO se factura (pago_fallido / pago_por_revisar / pago_tardio).
 *  - Sin conexión el kiosco se deshabilita.
 *  - El id de la forma de pago en Siigo sale de EPAYCO_SIIGO_PAYMENT_ID (src/config/siigo-map.ts).
 */
