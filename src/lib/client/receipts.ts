// Comprobantes en el navegador de la caja.
//  - La foto se REDUCE aquí (máx. 1600 px, JPEG) antes de enviarla, para ahorrar datos. El servidor igual la valida y la
//    recomprime (y es quien quita los metadatos).
//  - Sin conexión: la foto se guarda en IndexedDB (no en localStorage: no cabe) junto al id de la venta, y se sube cuando
//    vuelve la conexión y DESPUÉS de que la venta exista en el servidor (la cola de ventas va primero).
import { RECEIPT_MAX_SIDE } from "../receipt-rules";

const DB_NAME = "fecp_receipts";
const STORE = "pending";

export type PendingReceipt = { saleId: string; localNumber: string; blob: Blob; createdAt: number };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB no disponible"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "saleId" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("No se pudo abrir IndexedDB"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? new Error("Error de IndexedDB"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB abortado"));
    });
  } finally {
    db.close();
  }
}

export const savePendingReceipt = (r: PendingReceipt) => withStore("readwrite", (s) => s.put(r)).then(() => undefined);
export const deletePendingReceipt = (saleId: string) => withStore("readwrite", (s) => s.delete(saleId)).then(() => undefined);
export const listPendingReceipts = () => withStore<PendingReceipt[]>("readonly", (s) => s.getAll() as IDBRequest<PendingReceipt[]>);

/** Reduce la imagen a máx. 1600 px por lado y la convierte a JPEG. Respeta la orientación de la foto. */
export async function shrinkImage(input: Blob, maxSide = RECEIPT_MAX_SIDE, quality = 0.82): Promise<Blob> {
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(input, { imageOrientation: "from-image" });
  } catch {
    throw new Error("No se pudo leer la imagen. Use una foto JPG, PNG o WebP.");
  }
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("No se pudo procesar la imagen");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("No se pudo procesar la imagen"))), "image/jpeg", quality));
}

export type UploadResult = { kind: "ok" } | { kind: "retry" } | { kind: "missing" } | { kind: "rejected"; error: string };

/** Sube el comprobante de una venta. "missing" (404) = la venta aún no está en el servidor → se reintenta luego. */
export async function uploadReceipt(saleId: string, blob: Blob): Promise<UploadResult> {
  try {
    const form = new FormData();
    form.append("file", blob, "comprobante.jpg");
    const res = await fetch(`/api/sales/${saleId}/comprobante`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (res.ok) return { kind: "ok" };
    if (res.status === 404) return { kind: "missing" };
    if (res.status === 401 || res.status >= 500) return { kind: "retry" };
    const d = await res.json().catch(() => ({}));
    // 409 "ya tiene comprobante": un envío anterior sí llegó (se perdió la respuesta) → se da por hecho
    if (res.status === 409 && /ya tiene comprobante/i.test(String(d.error ?? ""))) return { kind: "ok" };
    return { kind: "rejected", error: String(d.error ?? `Error ${res.status}`) };
  } catch {
    return { kind: "retry" };
  }
}

let flushing = false;

/**
 * Sube los comprobantes guardados en este equipo. Se salta los de ventas que todavía están en la cola local
 * (primero debe existir la venta en el servidor).
 */
export async function flushReceipts(salesStillQueued: Set<string>, onRejected?: (p: PendingReceipt, error: string) => void) {
  if (flushing) return;
  flushing = true;
  try {
    let items: PendingReceipt[];
    try {
      items = await listPendingReceipts();
    } catch {
      return;
    }
    for (const p of items.sort((a, b) => a.createdAt - b.createdAt)) {
      if (salesStillQueued.has(p.saleId)) continue;
      const r = await uploadReceipt(p.saleId, p.blob);
      if (r.kind === "ok") await deletePendingReceipt(p.saleId).catch(() => {});
      else if (r.kind === "rejected") {
        await deletePendingReceipt(p.saleId).catch(() => {});
        onRejected?.(p, r.error);
      } else if (r.kind === "missing") {
        // La venta no está en el servidor (p. ej. fue rechazada). Se guarda una semana por si llega; luego se avisa.
        if (Date.now() - p.createdAt > 7 * 24 * 3600_000) {
          await deletePendingReceipt(p.saleId).catch(() => {});
          onRejected?.(p, "la venta no existe en el servidor");
        }
      } else break; // sin conexión: reintentar después
    }
  } finally {
    flushing = false;
  }
}
