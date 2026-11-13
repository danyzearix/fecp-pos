// Reglas del comprobante de pago (código puro: lo usan el navegador y el servidor).
//  - Transferencia (Nequi/Bancolombia/otra): OBLIGATORIO.
//  - Tarjeta débito / crédito (datáfono): OPCIONAL.
//  - Efectivo y ePayco: no aplica.
// El comprobante es evidencia para auditoría: NO reemplaza la referencia ni la casilla "Verifiqué el pago…".
export const RECEIPT_REQUIRED_METHODS = ["transferencia"] as const;
export const RECEIPT_OPTIONAL_METHODS = ["tarjeta_debito", "tarjeta_credito"] as const;

export const receiptRequired = (method: string) => (RECEIPT_REQUIRED_METHODS as readonly string[]).includes(method);
export const receiptAllowed = (method: string) => receiptRequired(method) || (RECEIPT_OPTIONAL_METHODS as readonly string[]).includes(method);

/** Tamaño máximo del archivo ANTES de comprimir (se valida en el servidor). */
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
/** Lado máximo de la imagen guardada (el navegador ya la reduce a esto antes de enviarla). */
export const RECEIPT_MAX_SIDE = 1600;

export type ReceiptStatus = "activo" | "pendiente" | "eliminado";
