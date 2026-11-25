// Reglas del comprobante de pago (código puro: lo usan el navegador y el servidor).
//  - La FOTO del comprobante es OPCIONAL en Transferencia y en Tarjeta (el cliente valida las transacciones con su propio método interno).
//    La referencia y la casilla "Verifiqué el pago…" siguen siendo obligatorias: sirven para conciliar.
//  - Para volver a EXIGIR la foto con Transferencia: REQUIRE_RECEIPT_PHOTO=true (src/lib/config.ts → requireReceiptPhoto). La foto de la Tarjeta
//    siempre fue opcional.
//  - Una venta sin foto NO es un error ni queda "pendiente": solo se muestra "Sin comprobante" como dato.
//  - Efectivo, Crédito FECP y ePayco solos: no aplica.
// Las funciones reciben el medio de la venta o la LISTA de medios de sus líneas de pago.
// El comprobante es evidencia para auditoría: NO reemplaza la referencia ni la casilla "Verifiqué el pago…".
export const RECEIPT_REQUIRED_METHODS = ["transferencia"] as const;
export const RECEIPT_OPTIONAL_METHODS = ["tarjeta", "tarjeta_debito", "tarjeta_credito"] as const;

const list = (m: string | readonly string[]) => (typeof m === "string" ? [m] : m);
/** ¿La foto es OBLIGATORIA? Solo si REQUIRE_RECEIPT_PHOTO=true (`requirePhoto`) y la venta tiene una línea de Transferencia. Por defecto: no. */
export const receiptRequired = (methods: string | readonly string[], requirePhoto = false) =>
  requirePhoto && list(methods).some((m) => (RECEIPT_REQUIRED_METHODS as readonly string[]).includes(m));
/** ¿Se puede adjuntar una foto? Transferencia y Tarjeta (obligatoria u opcional según REQUIRE_RECEIPT_PHOTO). */
export const receiptAllowed = (methods: string | readonly string[]) =>
  list(methods).some((m) => (RECEIPT_REQUIRED_METHODS as readonly string[]).includes(m) || (RECEIPT_OPTIONAL_METHODS as readonly string[]).includes(m));

/** Tamaño máximo del archivo ANTES de comprimir (se valida en el servidor). */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
/** Lado máximo de la imagen guardada (el navegador ya la reduce a esto antes de enviarla). */
export const RECEIPT_MAX_SIDE = 1600;

export type ReceiptStatus = "activo" | "pendiente" | "eliminado";
