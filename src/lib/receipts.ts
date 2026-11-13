// Comprobantes de pago (foto del voucher del datáfono o de la transferencia). Evidencia para auditoría: NO reemplaza
// la referencia ni la casilla "Verifiqué el pago…", que siguen siendo obligatorias.
//
// Reglas:
//  - Transferencia: comprobante OBLIGATORIO (si la venta llega sin él queda "pendiente"). Débito/crédito: opcional.
//    Efectivo y ePayco: no aplica.
//  - Una imagen por venta. Solo un admin puede reemplazar una que ya existe.
//  - Archivos FUERA de public/ (volumen propio, RECEIPTS_DIR), con nombre aleatorio (UUID). Nunca el nombre del navegador.
//  - Se valida el tipo REAL por el contenido (firma de bytes), máximo 10 MB antes de comprimir, y se recomprime con sharp:
//    máx. 1600 px por lado, JPEG calidad 75, SIN metadatos (EXIF, GPS…).
//  - Retención: a los RECEIPT_RETENTION_DAYS (180) días desde la fecha de la venta se borra el archivo y queda el registro
//    con estado 'eliminado' y su fecha.
import crypto from "node:crypto";
import { mkdir, rename, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { query } from "./db";
import { writeLog } from "./log";
import { RECEIPT_MAX_BYTES, RECEIPT_MAX_SIDE, receiptAllowed, type ReceiptStatus } from "./receipt-rules";
import { SALE_DAY_SQL, todayBogota, yesterdayBogota } from "./sales";

export { RECEIPT_MAX_BYTES, RECEIPT_MAX_SIDE, receiptAllowed, receiptRequired, type ReceiptStatus } from "./receipt-rules";
const JPEG_QUALITY = 75;

/** Carpeta de los comprobantes. En Docker es el volumen fecp_pos_uploads montado en /app/uploads. NUNCA dentro de public/. */
export function receiptsDir(): string {
  // turbopackIgnore: es una carpeta de DATOS en tiempo de ejecución; sin esta marca Turbopack incluiría todo el proyecto en el build
  return path.resolve(/*turbopackIgnore: true*/ process.env.RECEIPTS_DIR || path.join(process.cwd(), "uploads", "comprobantes"));
}

export function retentionDays(): number {
  const n = Number(process.env.RECEIPT_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 1 ? n : 180;
}

/** Ruta absoluta de un archivo guardado. Rechaza cualquier ruta que intente salir de la carpeta. */
function absolutePath(rel: string): string {
  const dir = receiptsDir();
  const abs = path.resolve(/*turbopackIgnore: true*/ dir, rel);
  if (!abs.startsWith(dir + path.sep)) throw new Error("Ruta de comprobante no válida");
  return abs;
}

// ------------------------------------------------------------------ tipo real por el contenido
export type ImageKind = "jpeg" | "png" | "webp";
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

export class ReceiptError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Recomprime la imagen: corrige la orientación, máx. 1600 px por lado, JPEG ~75, y descarta TODOS los metadatos
 * (sharp no copia EXIF/GPS/ICC salvo que se le pida con withMetadata, y aquí no se pide).
 */
export async function compressReceipt(input: Uint8Array): Promise<{ data: Buffer; width: number; height: number }> {
  if (input.byteLength > RECEIPT_MAX_BYTES) throw new ReceiptError(413, "La imagen pesa más de 10 MB.");
  if (!sniffImage(input)) throw new ReceiptError(415, "El archivo no es una imagen válida (solo JPG, PNG o WebP).");
  try {
    const { data, info } = await sharp(input, { limitInputPixels: 50_000_000, failOn: "error" })
      .rotate() // aplica la orientación EXIF ANTES de descartar los metadatos
      .resize({ width: RECEIPT_MAX_SIDE, height: RECEIPT_MAX_SIDE, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new ReceiptError(415, "No se pudo leer la imagen (archivo dañado o formato no soportado).");
  }
}

// ------------------------------------------------------------------ permisos
export type ReceiptSale = { id: string; local_number: string; payment_method: string; payment_reference: string | null; cashier_id: number; sale_day: string; created_day: string };

export async function loadReceiptSale(id: string): Promise<ReceiptSale | null> {
  const { rows } = await query<ReceiptSale>(
    `SELECT s.id, s.local_number, s.payment_method, s.payment_reference, s.cashier_id,
            ${SALE_DAY_SQL}::text AS sale_day, (s.created_at AT TIME ZONE 'America/Bogota')::date::text AS created_day
       FROM sales s WHERE s.id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/** Admin: todas. Cajero: solo sus ventas de hoy o ayer (la misma regla de reimprimir). Cliente: nunca. */
export function canAccessReceipt(user: { uid: number; role: string }, s: ReceiptSale): boolean {
  if (user.role === "admin") return true;
  if (user.role !== "cajero") return false;
  const ok = new Set([todayBogota(), yesterdayBogota()]);
  return s.cashier_id === user.uid && (ok.has(s.sale_day) || ok.has(s.created_day));
}

// ------------------------------------------------------------------ base de datos
export type ReceiptRow = {
  sale_id: string;
  status: ReceiptStatus;
  file_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  uploaded_at: Date | null;
  uploaded_by: number | null;
  deleted_at: Date | null;
};

export async function getReceipt(saleId: string): Promise<ReceiptRow | null> {
  const { rows } = await query<ReceiptRow>(
    "SELECT sale_id, status, file_path, mime_type, size_bytes, uploaded_at, uploaded_by, deleted_at FROM sale_receipts WHERE sale_id = $1",
    [saleId]
  );
  return rows[0] ?? null;
}

/**
 * Guarda el comprobante de una venta. Una imagen por venta: si ya hay una ACTIVA, solo un admin puede reemplazarla.
 * Escribe primero el archivo (nombre UUID, permisos 600) y luego el registro; si el registro falla, borra el archivo.
 */
export async function saveReceipt(p: { sale: ReceiptSale; input: Uint8Array; user: { uid: number; role: string; name: string } }) {
  if (!receiptAllowed(p.sale.payment_method)) throw new ReceiptError(400, "Este medio de pago no lleva comprobante (solo transferencia y tarjeta).");
  const prev = await getReceipt(p.sale.id);
  if (prev?.status === "activo" && p.user.role !== "admin") throw new ReceiptError(409, "Esta venta ya tiene comprobante. Solo un administrador puede reemplazarlo.");
  if (prev?.status === "eliminado" && p.user.role !== "admin") throw new ReceiptError(409, "El comprobante de esta venta fue eliminado por retención.");

  const originalBytes = p.input.byteLength;
  const { data, width, height } = await compressReceipt(p.input);

  // Carpeta por mes para no tener miles de archivos en un solo directorio
  const month = todayBogota().slice(0, 7);
  const rel = path.posix.join(month, `${crypto.randomUUID()}.jpg`);
  const abs = absolutePath(rel);
  await mkdir(/*turbopackIgnore: true*/ path.dirname(abs), { recursive: true, mode: 0o700 });
  const tmp = `${abs}.${process.pid}.tmp`;
  await writeFile(/*turbopackIgnore: true*/ tmp, data, { mode: 0o600 });
  await rename(/*turbopackIgnore: true*/ tmp, abs);

  try {
    const { rows } = await query<{ sale_id: string }>(
      `INSERT INTO sale_receipts (sale_id, status, file_path, mime_type, size_bytes, original_bytes, width, height, uploaded_at, uploaded_by, deleted_at, updated_at)
       VALUES ($1,'activo',$2,'image/jpeg',$3,$4,$5,$6,now(),$7,NULL,now())
       ON CONFLICT (sale_id) DO UPDATE SET status = 'activo', file_path = EXCLUDED.file_path, mime_type = EXCLUDED.mime_type,
             size_bytes = EXCLUDED.size_bytes, original_bytes = EXCLUDED.original_bytes, width = EXCLUDED.width, height = EXCLUDED.height,
             uploaded_at = now(), uploaded_by = EXCLUDED.uploaded_by, deleted_at = NULL, updated_at = now()
        WHERE sale_receipts.status = 'pendiente' OR $8::boolean
       RETURNING sale_id`,
      [p.sale.id, rel, data.byteLength, originalBytes, width, height, p.user.uid, p.user.role === "admin"]
    );
    if (!rows[0]) throw new ReceiptError(409, "Esta venta ya tiene comprobante. Solo un administrador puede reemplazarlo.");
  } catch (e) {
    await rm(/*turbopackIgnore: true*/ abs, { force: true }).catch(() => {});
    throw e;
  }

  // Reemplazo (solo admin): el archivo anterior se borra
  if (prev?.file_path && prev.file_path !== rel) await rm(/*turbopackIgnore: true*/ absolutePath(prev.file_path), { force: true }).catch(() => {});

  await writeLog("venta", `${prev?.status === "activo" ? "Comprobante REEMPLAZADO" : "Comprobante adjuntado"} en ${p.sale.local_number} por ${p.user.name}`, {
    userId: p.user.uid,
    detail: { sale_id: p.sale.id, bytes_original: originalBytes, bytes: data.byteLength, width, height, replaced: prev?.status === "activo" },
  });
  return { status: "activo" as const, size: data.byteLength, width, height };
}

export async function readReceiptFile(r: ReceiptRow): Promise<Buffer> {
  if (r.status !== "activo" || !r.file_path) throw new ReceiptError(404, "No hay comprobante");
  try {
    return await readFile(/*turbopackIgnore: true*/ absolutePath(r.file_path));
  } catch {
    throw new ReceiptError(404, "El archivo del comprobante no se encontró");
  }
}

/** Nombre claro para la descarga: comprobante-C01-000123-2026-11-12.jpg */
export const downloadName = (local: string, day: string) => `comprobante-${local.replace(/[^A-Za-z0-9-]/g, "")}-${day}.jpg`;

// ------------------------------------------------------------------ retención (tarea diaria)
/**
 * Borra los ARCHIVOS de comprobantes con más de N días contados desde la fecha de la venta. El registro se conserva con
 * estado 'eliminado' y su fecha. Devuelve cuántos eliminó.
 */
export async function purgeExpiredReceipts(days = retentionDays()): Promise<number> {
  const { rows } = await query<{ sale_id: string; file_path: string | null }>(
    `SELECT r.sale_id, r.file_path FROM sale_receipts r JOIN sales s ON s.id = r.sale_id
      WHERE r.status = 'activo' AND COALESCE(s.created_at_device, s.created_at) < now() - make_interval(days => $1)
      LIMIT 5000`,
    [days]
  );
  let n = 0;
  for (const r of rows) {
    if (r.file_path) {
      try {
        await rm(/*turbopackIgnore: true*/ absolutePath(r.file_path), { force: true });
      } catch {
        continue; // si no se pudo borrar el archivo, NO se marca: se reintenta mañana
      }
    }
    const u = await query("UPDATE sale_receipts SET status = 'eliminado', deleted_at = now(), file_path = NULL, updated_at = now() WHERE sale_id = $1 AND status = 'activo'", [r.sale_id]);
    n += u.rowCount ?? 0;
  }
  return n;
}

/**
 * Ejecuta la retención como mucho UNA vez por día (hora de Bogotá), aunque haya varios procesos: el "bloqueo" es un
 * UPDATE condicional en la base (solo un proceso logra cambiar la fecha de la última corrida).
 */
export async function runDailyReceiptRetention(): Promise<{ ran: boolean; deleted: number }> {
  const today = todayBogota();
  const claim = await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ('receipt_retention_last_run', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value < EXCLUDED.value
     RETURNING key`,
    [today]
  );
  if (!claim.rowCount) return { ran: false, deleted: 0 };
  const days = retentionDays();
  const deleted = await purgeExpiredReceipts(days);
  await writeLog("admin", `Retención de comprobantes (${days} días): ${deleted} archivo(s) eliminado(s)`, { detail: { days, deleted } });
  return { ran: true, deleted };
}
