// Reglas del comprobante de pago (código puro: lo usan el navegador y el servidor).
//  - Si la venta tiene una línea de Transferencia (Nequi/Bancolombia/otra): OBLIGATORIO (una foto por venta).
//  - Si solo tiene Tarjeta (datáfono; o las históricas débito/crédito): OPCIONAL.
//  - Efectivo, Crédito FECP y ePayco solos: no aplica.
// Las funciones reciben el medio de la venta o la LISTA de medios de sus líneas de pago.
// El comprobante es evidencia para auditoría: NO reemplaza la referencia ni la casilla "Verifiqué el pago…".
export const RECEIPT_REQUIRED_METHODS = ["transferencia"] as const;
export const RECEIPT_OPTIONAL_METHODS = ["tarjeta", "tarjeta_debito", "tarjeta_credito"] as const;

const list = (m: string | readonly string[]) => (typeof m === "string" ? [m] : m);
export const receiptRequired = (methods: string | readonly string[]) => list(methods).some((m) => (RECEIPT_REQUIRED_METHODS as readonly string[]).includes(m));
export const receiptAllowed = (methods: string | readonly string[]) =>
  receiptRequired(methods) || list(methods).some((m) => (RECEIPT_OPTIONAL_METHODS as readonly string[]).includes(m));

/** Tamaño máximo del archivo ANTES de comprimir (se valida en el servidor). */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
/** Lado máximo de la imagen guardada (el navegador ya la reduce a esto antes de enviarla). */
export const RECEIPT_MAX_SIDE = 1600;

export type ReceiptStatus = "activo" | "pendiente" | "eliminado";
