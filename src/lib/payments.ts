// Medios de pago del POS (navegador y servidor). El id interno NO cambia aunque cambie la etiqueta,
// porque se guarda en sales.payment_method y se mapea a Siigo en src/config/siigo-map.ts.

export const PAYMENT_METHODS = [
  { id: "efectivo", label: "Efectivo" },
  { id: "tarjeta_debito", label: "Tarjeta débito" },
  { id: "tarjeta_credito", label: "Tarjeta crédito" },
  { id: "transferencia", label: "Transferencia (Nequi/Bancolombia/otra)" },
  // Solo lo asigna el servidor a las ventas del kiosco (etapa 5B). Un cajero NO puede elegirlo.
  { id: "epayco", label: "Pago electrónico (ePayco)" },
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number]["id"];

/** Medios que puede elegir un cajero en el modal de cobro y que acepta POST /api/sales */
export const CASHIER_PAYMENT_METHODS = PAYMENT_METHODS.filter((m) => m.id !== "epayco");

export const paymentLabel = (id: string) => PAYMENT_METHODS.find((m) => m.id === id)?.label ?? id;

/** Todo medio distinto de efectivo exige referencia del comprobante (en ePayco: el ref_payco verificado). */
export const requiresReference = (id: string) => id !== "efectivo";

// TODO etapa 5: mostrar sales.payment_reference en /ventas (historial) y en /admin/reportes
// (reporte por medio de pago), junto al medio de pago.   (hecho en 5A)

/*
 * Pago electrónico (ePayco) — autoservicio, etapa 5B. Resumen de las reglas (el detalle está en src/lib/epayco/):
 *  - Una venta del kiosco nace en 'esperando_pago'. NO se factura hasta que el SERVIDOR verifique el pago
 *    con ePayco (consulta del ref_payco o webhook firmado); nunca por lo que diga el navegador.
 *  - Si el pago falla, vence o algo no coincide, NO se factura (pago_fallido / pago_por_revisar / pago_tardio).
 *  - Sin conexión el kiosco se deshabilita.
 *  - El id de la forma de pago en Siigo sale de EPAYCO_SIIGO_PAYMENT_ID (src/config/siigo-map.ts).
 */
