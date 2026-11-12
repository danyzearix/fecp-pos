import { query } from "./db";

export type LogType = "venta" | "factura" | "sync" | "login" | "error" | "admin" | "seguridad" | "pago";
export type LogLevel = "info" | "warn" | "error";

/** Escribe en la tabla logs. Nunca lanza error: un fallo de log no debe romper una venta. */
export async function writeLog(
  type: LogType,
  message: string,
  opts: { level?: LogLevel; userId?: number | null; detail?: unknown } = {}
) {
  try {
    await query(
      "INSERT INTO logs (level, type, user_id, message, detail) VALUES ($1,$2,$3,$4,$5)",
      [
        opts.level ?? "info",
        type,
        opts.userId ?? null,
        message,
        opts.detail === undefined ? null : JSON.stringify(opts.detail),
      ]
    );
  } catch (e) {
    console.error("[log] no se pudo escribir el log:", e);
  }
}
